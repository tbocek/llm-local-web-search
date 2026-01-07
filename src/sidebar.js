(function () {
  const $ = (id) => document.getElementById(id);
  let lastStateJSON = "";

  const STATUS_CONFIG = {
    idle: { text: "Idle", class: "" },
    searching: { text: "Searching", class: "active" },
    extracting: { text: "Extracting", class: "active" },
    ready: { text: "Ready", class: "active" },
    complete: { text: "Complete", class: "active" },
    error: { text: "Error", class: "error" },
  };

  const STATUS_LABELS = {
    pending: "Pending",
    loading: "Loading",
    loaded: "Loaded",
    blocked: "Blocked",
    error: "Error",
  };

  function updateUI(state) {
    const stateJSON = JSON.stringify(state);
    if (stateJSON === lastStateJSON) return;
    lastStateJSON = stateJSON;

    // Status badge
    const cfg = STATUS_CONFIG[state.status] || STATUS_CONFIG.idle;
    $("statusBadge").textContent = cfg.text;
    $("statusBadge").className = "status-badge " + cfg.class;

    // Search query
    const searchQuery = $("searchQuery");
    if (state.query) {
      searchQuery.textContent = `🔎 ${state.query}`;
      searchQuery.classList.add("active");
    } else {
      searchQuery.classList.remove("active");
    }

    // Sites list
    const sites = state.sites || [];
    const loadedCount = sites.filter((s) => s.status === "loaded").length;

    $("siteCount").textContent = loadedCount;
    $("siteTotal").textContent = sites.length;

    if (sites.length) {
      $("sitesList").textContent = "";
      sites.forEach((site, i) => {
        const item = document.createElement("div");
        item.className = "site-item";
        item.dataset.tabId = site.tabId || "";

        const index = document.createElement("div");
        index.className = "site-index";
        index.textContent = i + 1;

        const info = document.createElement("div");
        info.className = "site-info";

        const title = document.createElement("div");
        title.className = "site-title";
        title.textContent = site.title || "Loading...";

        const url = document.createElement("div");
        url.className = "site-url";
        url.textContent = new URL(site.url).hostname;

        const status = document.createElement("span");
        status.className = "site-status " + site.status;
        status.textContent = STATUS_LABELS[site.status] || site.status;

        info.appendChild(title);
        info.appendChild(url);
        item.appendChild(index);
        item.appendChild(info);
        item.appendChild(status);

        $("sitesList").appendChild(item);
      });

      $("sitesList")
        .querySelectorAll(".site-item")
        .forEach((item) => {
          item.addEventListener("click", (e) => {
            const tabId = parseInt(item.dataset.tabId);
            if (!tabId) return;
            browser.tabs.update(tabId, { active: true });
            if ((e.ctrlKey || e.metaKey) && state.windowId) {
              browser.windows.update(state.windowId, { focused: true });
            }
          });
        });
    } else {
      $("sitesList").textContent = "";
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No searches";
      $("sitesList").appendChild(empty);
    }

    // Buttons
    $("submitBtn").disabled =
      (state.status !== "ready" && state.status !== "extracting") ||
      loadedCount === 0;
  }

  $("submitBtn").addEventListener("click", () => {
    browser.sidebarAction.close();
    browser.runtime.sendMessage({ type: "forceSubmit" });
  });

  $("cancelBtn").addEventListener("click", () => {
    browser.sidebarAction.close();
    browser.runtime.sendMessage({ type: "cancelSearch" });
  });

  $("settingsLink").addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });

  // State sync
  browser.runtime
    .sendMessage({ type: "getState" })
    .then((s) => s && updateUI(s))
    .catch(() =>
      updateUI({
        // fallback if background not ready
        status: "idle",
        query: null,
        sites: [],
      }),
    );

  browser.runtime.onMessage.addListener(
    (msg) => msg.type === "stateUpdate" && updateUI(msg.state),
  );
})();
