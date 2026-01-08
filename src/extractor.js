(async function () {
  if (location.hostname.includes("duckduckgo.com")) return;
  if (location.hostname === "127.0.0.1") return;
  if (location.hostname === "localhost") return;

  const result = await browser.storage.local.get("settings");
  const settings = result.settings || {};
  const maxWait = settings.extractDelay ?? DEFAULT_SETTINGS.extractDelay;

  let extracted = false;

  function extract() {
    if (extracted) return;
    extracted = true;

    try {
      const clone = document.cloneNode(true);
      const article = new Readability(clone).parse();

      if (!article || !article.textContent || article.textContent.length < 100) {
        console.log("[Extractor] No article found:", location.href);
        browser.runtime.sendMessage({
          type: "pageContent",
          url: location.href,
          title: document.title,
          content: "",
          blocked: true,
          reason: "blocked",
        });
        return;
      }

      const text = article.textContent.replace(/\s+/g, " ").trim();
      console.log("[Extractor] Content from:", location.href, "length:", text.length);

      browser.runtime.sendMessage({
        type: "pageContent",
        url: location.href,
        title: article.title || document.title,
        content: text,
        blocked: false,
      });
    } catch (e) {
      console.log("[Extractor] Readability failed:", e);
      browser.runtime.sendMessage({
        type: "pageContent",
        url: location.href,
        title: document.title,
        content: "",
        blocked: true,
        reason: "error",
      });
    }
  }

  // Wait for browser idle (double callback for async content)
  requestIdleCallback(() => {
    requestIdleCallback(extract, { timeout: 1000 });
  }, { timeout: maxWait });

  // Max timeout fallback
  setTimeout(extract, maxWait);

  console.log("[Extractor] Loaded on:", location.href);
})();