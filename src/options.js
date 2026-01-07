(function () {
  const incognitoMode = document.getElementById("incognitoMode");
  const autoClose = document.getElementById("autoClose");
  const maxResults = document.getElementById("maxResults");
  const extractTimeout = document.getElementById("extractTimeout");
  const urlList = document.getElementById("urlList");
  const addUrlBtn = document.getElementById("addUrlBtn");
  const saveBtn = document.getElementById("saveBtn");
  const resetBtn = document.getElementById("resetBtn");
  const toast = document.getElementById("toast");
  const extractDelay = document.getElementById("extractDelay");

  let urlPatterns = [];

  // Load settings
  async function loadSettings() {
    const result = await browser.storage.local.get("settings");
    const settings = result.settings || DEFAULT_SETTINGS;

    incognitoMode.checked = settings.incognitoMode;
    autoClose.checked = settings.autoClose;
    maxResults.value = settings.maxResults;
    extractTimeout.value = settings.extractTimeout;
    urlPatterns = settings.urlPatterns;
    extractDelay.value = settings.extractDelay;

    renderUrlList();
    updateTimeoutVisibility();
  }

  // Save settings
  async function saveSettings() {
    const settings = {
      incognitoMode: incognitoMode.checked,
      autoClose: autoClose.checked,
      maxResults: parseInt(maxResults.value) || 10,
      extractTimeout: parseInt(extractTimeout.value) || 10,
      extractDelay: parseInt(extractDelay.value) || 3000,
      urlPatterns: urlPatterns.filter((u) => u.trim()),
    };

    await browser.storage.local.set({ settings });

    // Notify background script
    browser.runtime.sendMessage({ type: "settingsUpdated", settings });

    showToast();
  }

  // Reset to defaults
  async function resetSettings() {
    if (confirm("Reset all settings to defaults?")) {
      await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
      await loadSettings();
      showToast();
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
      });
    });

    urlList.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const index = parseInt(e.target.dataset.index);
        urlPatterns.splice(index, 1);
        renderUrlList();
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
      }
    }
  }

  // Show/hide timeout setting based on autoClose
  function updateTimeoutVisibility() {
    const timeoutGroup = extractTimeout.closest(".form-group");
    timeoutGroup.style.display = autoClose.checked ? "block" : "none";
  }

  // Show toast
  function showToast() {
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2000);
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Event listeners
  incognitoMode.addEventListener("change", handleIncognitoToggle);
  autoClose.addEventListener("change", updateTimeoutVisibility);
  addUrlBtn.addEventListener("click", addUrl);
  saveBtn.addEventListener("click", saveSettings);
  resetBtn.addEventListener("click", resetSettings);

  // Initial load
  loadSettings();
})();
