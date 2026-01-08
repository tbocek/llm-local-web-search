(async function () {
  // Convert wildcard pattern to regex
  function patternToRegex(pattern) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$");
  }

  // Check if URL matches any pattern
  function urlMatches(url, patterns) {
    return patterns.some((pattern) => patternToRegex(pattern).test(url));
  }

  const result = await browser.storage.local.get("settings");
  const urlPatterns = result.settings?.urlPatterns || [];

  if (!urlMatches(location.href, urlPatterns)) {
    return;
  }

  console.log("[Content] URL matched, injecting tools");

  const script = document.createElement("script");
  script.src = browser.runtime.getURL("injected.js");
  script.dataset.toolsUrl = browser.runtime.getURL("tools.json");
  document.documentElement.appendChild(script);

  // Message relay
  window.addEventListener("message", (event) => {
    if (event.data?.type === "llm-open-search") {
      browser.runtime.sendMessage({
        type: "openSearch",
        query: event.data.query,
        searchId: event.data.searchId,
      });
    }
  });

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "searchComplete") {
      window.postMessage(
        {
          type: "llm-search-complete",
          results: message.results,
          searchId: message.searchId,
           userNote: message.userNote, 
        },
        "*",
      );
    }
  });
})();
