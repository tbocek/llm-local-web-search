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
  console.log("[Background] Submitting", validResults.length, "valid results to LLM");

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
    console.log("[Background] Search from tab:", originTabId);

    collectedContent.clear();
    expectedCount = 0;
    trackedTabIds.clear();

    if (completionTimeout) {
      clearTimeout(completionTimeout);
      completionTimeout = null;
    }

    updateState({
      status: "searching",
      query: message.query,
      searchResults: null,
      sites: [],
    });

    browser.browserAction.setIcon({ path: "icon_active.svg" });

    try {
      const win = await browser.windows.create({
        url: `https://duckduckgo.com/?q=${encodeURIComponent(message.query)}`,
        incognito: settings.incognitoMode,
      });

      searchWindow = {
        windowId: win.id,
        tabId: win.tabs[0].id,
      };

      updateState({ windowId: win.id });
    } catch (e) {
      console.log("[Background] Error creating window:", e);
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

    const tabs = [];
    for (let i = 0; i < results.length; i++) {
      const tab = await browser.tabs.create({
        url: results[i].url,
        windowId: searchWindow.windowId,
        active: i === 0,
      });
      tabs.push(tab);
      trackedTabIds.add(tab.id);

      const sites = [...state.sites];
      sites[i] = { ...sites[i], tabId: tab.id, status: "loading" };
      updateState({ sites });
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
  if (searchWindow && searchWindow.windowId === windowId) {
    searchWindow = null;
    if (state.status !== "complete" && state.status !== "ready") {
      resetState();
      browser.browserAction.setIcon({ path: "icon.svg" });
    }
  }
});

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

console.log("[Background] Loaded");
