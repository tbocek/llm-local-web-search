(function () {
  const incognitoMode = document.getElementById("incognitoMode");
  const maxResults = document.getElementById("maxResults");
  const urlList = document.getElementById("urlList");
  const addUrlBtn = document.getElementById("addUrlBtn");
  const resetBtn = document.getElementById("resetBtn");
  const savedIndicator = document.getElementById("savedIndicator");
  const extractDelay = document.getElementById("extractDelay");

  let urlPatterns = [];

  function debounce(fn, ms) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), ms);
    };
  }

  // Load settings
  async function loadSettings() {
    const result = await browser.storage.local.get("settings");
    const settings = result.settings || DEFAULT_SETTINGS;

    incognitoMode.checked = settings.incognitoMode;
    maxResults.value = settings.maxResults;
    urlPatterns = settings.urlPatterns;
    extractDelay.value = settings.extractDelay;

    renderUrlList();
  }

  // Save settings
  async function saveSettings() {
    const settings = {
      incognitoMode: incognitoMode.checked,
      maxResults: parseInt(maxResults.value) || DEFAULT_SETTINGS.maxResults,
      extractDelay:
        parseInt(extractDelay.value) || DEFAULT_SETTINGS.extractDelay,
      urlPatterns: urlPatterns.filter((u) => u.trim()),
    };

    await browser.storage.local.set({ settings });
    browser.runtime.sendMessage({ type: "settingsUpdated", settings });
    showSaved();
  }

  const debouncedSave = debounce(saveSettings, 500);

  // Reset to defaults
  async function resetSettings() {
    if (confirm("Reset all settings to defaults?")) {
      await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
      await loadSettings();
      showSaved();
    }
  }

  // Render URL list
  function renderUrlList() {
    urlList.textContent = "";

    urlPatterns.forEach((url, index) => {
      const item = document.createElement("div");
      item.className = "url-item";

      const input = document.createElement("input");
      input.type = "text";
      input.value = url;
      input.dataset.index = index;
      input.placeholder = "http://127.0.0.1:*/*";

      const btn = document.createElement("button");
      btn.className = "remove-btn";
      btn.dataset.index = index;
      btn.textContent = "Remove";

      item.appendChild(input);
      item.appendChild(btn);
      urlList.appendChild(item);
    });

    urlList.querySelectorAll('input[type="text"]').forEach((input) => {
      input.addEventListener("input", (e) => {
        const index = parseInt(e.target.dataset.index);
        urlPatterns[index] = e.target.value;
        debouncedSave();
      });
    });

    urlList.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const index = parseInt(e.target.dataset.index);
        urlPatterns.splice(index, 1);
        renderUrlList();
        debouncedSave();
      });
    });
  }

  // Add new URL
  function addUrl() {
    urlPatterns.push("");
    renderUrlList();
    const inputs = urlList.querySelectorAll('input[type="text"]');
    if (inputs.length > 0) {
      inputs[inputs.length - 1].focus();
    }
  }

  // Check if incognito is allowed
  async function canUseIncognito() {
    try {
      const allowed = await browser.extension.isAllowedIncognitoAccess();
      return allowed;
    } catch (e) {
      return false;
    }
  }

  // Handle incognito toggle
  async function handleIncognitoToggle() {
    if (incognitoMode.checked) {
      const allowed = await canUseIncognito();
      if (!allowed) {
        incognitoMode.checked = false;
        alert(
          "Private window access is not enabled.\n\n" +
            "To enable:\n" +
            "1. Open about:addons in a new tab\n" +
            "2. Click on this extension\n" +
            "3. Enable 'Run in Private Windows' on the Details tab\n" +
            "4. Return here and try again",
        );
        return;
      }
    }
    debouncedSave();
  }

  // Show saved indicator
  function showSaved() {
    savedIndicator.classList.add("show");
    setTimeout(() => {
      savedIndicator.classList.remove("show");
    }, 2000);
  }

  // Event listeners
  incognitoMode.addEventListener("change", handleIncognitoToggle);
  maxResults.addEventListener("input", debouncedSave);
  extractDelay.addEventListener("input", debouncedSave);
  addUrlBtn.addEventListener("click", addUrl);
  resetBtn.addEventListener("click", resetSettings);

  // Initial load
  loadSettings();
})();
