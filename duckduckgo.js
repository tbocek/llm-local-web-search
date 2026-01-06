(async function () {
  const result = await browser.storage.local.get("settings");
  const settings = result.settings || {};
  const maxResults = result.settings.maxResults;
  const extractDelay = settings.extractDelay ?? 3000;

  function extractResults() {
    const links = [];
    const results = document.querySelectorAll(
      'a[data-testid="result-title-a"]',
    );

    results.forEach((a, i) => {
      if (i < maxResults && a.href) {
        links.push({
          title: a.textContent.trim(),
          url: a.href,
        });
      }
    });

    return links;
  }

  let sent = false;

  function trySend() {
    if (sent) return;
    const results = extractResults();
    if (results.length > 0) {
      console.log("[DDG] Found", results.length, "results");
      browser.runtime.sendMessage({
        type: "searchResults",
        results: results,
      });
      sent = true;
    }
  }

  const observer = new MutationObserver(trySend);
  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(trySend, extractDelay);

  console.log("[DDG] Loaded, maxResults:", maxResults);
})();
