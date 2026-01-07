(async function () {
  if (location.hostname.includes("duckduckgo.com")) return;
  if (location.hostname === "127.0.0.1") return;
  if (location.hostname === "localhost") return;

  const result = await browser.storage.local.get("settings");
  const settings = result.settings || {};
  const extractDelay = settings.extractDelay ?? 3000;

  setTimeout(() => {
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

      let text = article.textContent.replace(/\s+/g, " ").trim();
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
  }, extractDelay);

  console.log("[Extractor] Loaded on:", location.href);
})();