// State for popup
let state = {
  status: "idle",
  query: null,
  searchResults: null,
  sites: [],
  windowId: null,
};

let searchWindow = null;
let collectedContent = new Map();
let expectedCount = 0;
let completionTimeout = null;
let originTabId = null;
let trackedTabIds = new Set();
let currentSearchId = null;
let currentQueries = null;
let currentQueryLevel = null;
let originWindowId = null;
// Window ids the extension is closing on purpose (escalation / completion), so
// the onRemoved handler can tell those apart from the USER closing the window.
const expectedWindowCloses = new Set();
let settings = { ...DEFAULT_SETTINGS };

// Initialize settings on startup
browser.storage.local.get("settings").then((result) => {
  if (!result.settings) {
    browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    console.log("[Background] Settings initialized");
  } else {
    settings = { ...DEFAULT_SETTINGS, ...result.settings };
    console.log("[Background] Settings loaded:", settings);
  }
});

function updateState(updates) {
  state = { ...state, ...updates };
  browser.runtime.sendMessage({ type: "stateUpdate", state }).catch(() => {});
}

function resetState() {
  originWindowId = null;
  state = {
    status: "idle",
    query: null,
    searchResults: null,
    sites: [],
    windowId: null,
  };
  currentSearchId = null;
  trackedTabIds.clear();
  expectedCount = 0;
  collectedContent.clear();
  browser.runtime.sendMessage({ type: "stateUpdate", state }).catch(() => {});
}

async function onExtractionComplete() {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
    completionTimeout = null;
  }
  updateState({ status: "ready" });
}

async function cancelSearch() {
  originWindowId = null;
  if (completionTimeout) {
    clearTimeout(completionTimeout);
    completionTimeout = null;
  }

  // Send cancel message to LLM
  if (originTabId) {
    try {
      await browser.tabs.sendMessage(originTabId, {
        type: "searchComplete",
        results: [
          {
            title: "Canceled",
            url: "",
            content: "Search was canceled by the user.",
          },
        ],
        searchId: currentSearchId,
      });
    } catch (e) {}
  }

  if (searchWindow) {
    expectedWindowCloses.add(searchWindow.windowId);
    try {
      await browser.windows.remove(searchWindow.windowId);
    } catch (e) {}
    searchWindow = null;
  }

  browser.browserAction.setIcon({ path: "icon.svg" });
  resetState();
}

async function submit(userNote = "") {
  const validResults = Array.from(collectedContent.values()).filter(
    (r) => !r.blocked && r.content.length > 0,
  );
  console.log(
    "[Background] Submitting",
    validResults.length,
    "valid results to LLM",
  );

  updateState({ status: "complete" });
  browser.browserAction.setIcon({ path: "icon.svg" });

  if (originTabId) {
    try {
      await browser.tabs.sendMessage(originTabId, {
        type: "searchComplete",
        results: validResults,
        searchId: currentSearchId,
        userNote: userNote,
      });
    } catch (e) {
      console.log("[Background] Error sending results:", e);
    }
  }

  if (searchWindow) {
    expectedWindowCloses.add(searchWindow.windowId);
    try {
      await browser.windows.remove(searchWindow.windowId);
    } catch (e) {}
    searchWindow = null;
  }

  expectedCount = 0;
  collectedContent.clear();
  trackedTabIds.clear();

  setTimeout(resetState, 5000);
}

// Open a DDG search window for `query`, positioned bottom-right at 1/3 size, and
// record it as the active searchWindow. Returns the created window, or null on
// failure. Shared by the initial search and the narrow→medium→broad escalation.
async function openSearchWindow(query, targetWindowId) {
  try {
    let currentWindow;
    if (targetWindowId) {
      currentWindow = await browser.windows.get(targetWindowId);
    } else {
      currentWindow = await browser.windows.getCurrent();
    }
    const width = Math.round(currentWindow.width / 3);
    const height = Math.round(currentWindow.height / 3);

    const win = await browser.windows.create({
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      incognito: settings.incognitoMode,
      width: width,
      height: height,
      left: currentWindow.left + currentWindow.width - width,
      top: currentWindow.top + Math.round((currentWindow.height - height) / 2),
    });

    searchWindow = {
      windowId: win.id,
      tabId: win.tabs[0].id,
    };
    return win;
  } catch (e) {
    console.log("[Background] Error creating search window:", e);
    return null;
  }
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === "getState") {
    return state;
  }

  if (message.type === "settingsUpdated") {
    settings = message.settings;
    console.log("[Background] Settings updated:", settings);
    return;
  }

  if (message.type === "cancelSearch") {
    await cancelSearch();
    return;
  }

  if (message.type === "submit") {
    await submit(message.userNote);
    return;
  }

  if (message.type === "openSearch") {
    const result = await browser.storage.local.get("settings");
    settings = { ...DEFAULT_SETTINGS, ...result.settings };

    currentSearchId = message.searchId;
    originTabId = sender.tab?.id;
    originWindowId = sender.tab?.windowId;
    console.log("[Background] Search from tab:", originTabId);

    collectedContent.clear();
    expectedCount = 0;
    trackedTabIds.clear();

    if (completionTimeout) {
      clearTimeout(completionTimeout);
      completionTimeout = null;
    }

    currentQueries = message.queries;
    currentQueryLevel = "narrow";

    const currentQuery = currentQueries.narrow;

    updateState({
      status: "searching",
      query: currentQuery,
      searchResults: null,
      sites: [],
    });

    browser.browserAction.setIcon({ path: "icon_active.svg" });

    const win = await openSearchWindow(currentQuery, originWindowId);
    if (win) {
      updateState({ windowId: win.id });
    } else {
      updateState({ status: "error" });
    }
  }

  if (message.type === "searchResults") {
    const result = await browser.storage.local.get("settings");
    settings = { ...DEFAULT_SETTINGS, ...result.settings };

    const senderTabId = sender.tab?.id;

    // Only accept results from current DDG tab
    if (!searchWindow || senderTabId !== searchWindow.tabId) {
      console.log(
        "[Background] Ignoring stale searchResults from tab:",
        senderTabId,
      );
      return;
    }

    console.log("[Background] Got search results:", message.results.length);

    // If no results, escalate to next query level
    if (message.results.length === 0) {
      console.log(
        "[Background] No results, escalating from",
        currentQueryLevel,
      );
      const levels = ["narrow", "medium", "broad"];
      const currentIndex = levels.indexOf(currentQueryLevel);

      if (currentIndex < levels.length - 1) {
        // Escalate to next level
        currentQueryLevel = levels[currentIndex + 1];
        const nextQuery = currentQueries[currentQueryLevel];
        console.log(
          "[Background] Trying next level:",
          currentQueryLevel,
          nextQuery,
        );

        // Close current DDG tab (which closes its window) — mark it so the
        // onRemoved handler doesn't mistake this for a user abort.
        try {
          if (searchWindow) {
            expectedWindowCloses.add(searchWindow.windowId);
            await browser.tabs.remove(searchWindow.tabId);
          }
        } catch (e) {
          console.log("[Background] Error closing tab:", e);
        }

        // Open a new DDG window with the next query
        const win = await openSearchWindow(nextQuery, originWindowId);
        if (win) {
          updateState({ query: nextQuery, windowId: win.id });
        }
        return;
      } else {
        // All levels exhausted, send empty results
        console.log(
          "[Background] All query levels exhausted, no results found",
        );
        updateState({ status: "complete" });
        browser.browserAction.setIcon({ path: "icon.svg" });

        if (originTabId) {
          try {
            await browser.tabs.sendMessage(originTabId, {
              type: "searchComplete",
              results: [
                {
                  title: "No results",
                  url: "",
                  content:
                    "No search results found for any of the provided queries (narrow, medium, broad).",
                },
              ],
              searchId: currentSearchId,
            });
          } catch (e) {
            console.log("[Background] Error sending no-results message:", e);
          }
        }

        if (searchWindow) {
          expectedWindowCloses.add(searchWindow.windowId);
          try {
            await browser.windows.remove(searchWindow.windowId);
          } catch (e) {}
          searchWindow = null;
        }

        setTimeout(resetState, 5000);
        return;
      }
    }

    const maxResults = settings.maxResults;
    const results = message.results.slice(0, maxResults);

    expectedCount = results.length;
    collectedContent.clear();
    trackedTabIds.clear();

    updateState({
      status: "extracting",
      searchResults: results,
      sites: results.map((r, i) => ({
        url: r.url,
        title: r.title,
        status: "pending",
        tabId: null,
      })),
    });

    const timeout = 600000;
    completionTimeout = setTimeout(() => {
      console.log(
        "[Background] Timeout with",
        collectedContent.size,
        "results",
      );
      onExtractionComplete();
    }, timeout);

    if (!searchWindow) {
      console.log("[Background] No search window");
      return;
    }

    // Pin every result tab to ONE window — the search window. Capture its id
    // once (an interleaving message can reassign searchWindow mid-loop and
    // scatter the tabs), and verify it's still alive: tabs.create with a closed
    // windowId silently lands in the user's focused window. If the search window
    // was closed (escalation churn / manual close), open a fresh dedicated one
    // and drop its blank starter tab once the result tabs are in.
    let targetWindowId = searchWindow.windowId;
    let starterTabId = null;
    try {
      await browser.windows.get(targetWindowId);
    } catch (e) {
      console.log("[Background] Search window gone — reopening for results");
      const ref = await browser.windows
        .get(originWindowId)
        .catch(() => browser.windows.getCurrent());
      const width = Math.round(ref.width / 3);
      const height = Math.round(ref.height / 3);
      const win = await browser.windows.create({
        incognito: settings.incognitoMode,
        width: width,
        height: height,
        left: ref.left + ref.width - width,
        top: ref.top + Math.round((ref.height - height) / 2),
      });
      targetWindowId = win.id;
      starterTabId = win.tabs[0].id;
      searchWindow = { windowId: win.id, tabId: null };
    }

    const tabs = [];
    for (let i = 0; i < results.length; i++) {
      const tab = await browser.tabs.create({
        url: results[i].url,
        windowId: targetWindowId,
        active: i === 0,
      });
      tabs.push(tab);
      trackedTabIds.add(tab.id);

      const sites = [...state.sites];
      sites[i] = { ...sites[i], tabId: tab.id, status: "loading" };
      updateState({ sites });
    }

    // Remove the fresh window's blank starter tab now that the result tabs hold
    // it open (removing it earlier would close the empty window).
    if (starterTabId) {
      browser.tabs.remove(starterTabId).catch(() => {});
    }

    if (browser.tabs.group) {
      try {
        const tabIds = tabs.map((t) => t.id);
        await browser.tabs.group({ tabIds });
        console.log("[Background] Tabs grouped");
      } catch (e) {
        console.log("[Background] Tab grouping not supported:", e);
      }
    }

    searchWindow.tabId = tabs[0]?.id;
  }

  if (message.type === "pageContent") {
    const senderTabId = sender.tab?.id;
    console.log(
      "[Background] Got content from tab:",
      senderTabId,
      "url:",
      message.url,
    );

    // Only process if it's one of our tracked tabs
    if (!trackedTabIds.has(senderTabId)) {
      console.log("[Background] Ignoring - not a tracked tab");
      return;
    }

    // Store/update content for this tab (keeps latest)
    collectedContent.set(senderTabId, {
      url: message.url,
      title: message.title,
      content: message.content,
      blocked: message.blocked,
    });

    // Update site status by tab ID
    const sites = [...state.sites];
    const siteIndex = sites.findIndex((s) => s.tabId === senderTabId);

    if (siteIndex !== -1) {
      let status = "loaded";
      if (message.blocked) {
        status = message.reason || "blocked";
      }
      sites[siteIndex] = { ...sites[siteIndex], status, title: message.title };
      updateState({ sites });
    } else {
      console.log("[Background] No matching site for tab:", senderTabId);
    }

    console.log(
      "[Background] Collected",
      collectedContent.size,
      "of",
      expectedCount,
    );

    if (collectedContent.size >= expectedCount && expectedCount > 0) {
      onExtractionComplete();
    }
  }
});

browser.windows.onRemoved.addListener((windowId) => {
  if (!searchWindow || searchWindow.windowId !== windowId) return;
  searchWindow = null;

  // The extension closed it on purpose (escalation / completion) — not an abort.
  if (expectedWindowCloses.delete(windowId)) return;

  // The user closed the search window while a search was in flight. Tell the LLM
  // the search was aborted so its tool call resolves instead of hanging.
  if (state.status === "searching" || state.status === "extracting") {
    if (completionTimeout) {
      clearTimeout(completionTimeout);
      completionTimeout = null;
    }
    if (originTabId) {
      browser.tabs
        .sendMessage(originTabId, {
          type: "searchComplete",
          results: [
            {
              title: "Aborted",
              url: "",
              content: "Search was aborted by the user (search window closed).",
            },
          ],
          searchId: currentSearchId,
        })
        .catch(() => {});
    }
    browser.browserAction.setIcon({ path: "icon.svg" });
    resetState();
  }
});

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

console.log("[Background] Loaded");
