"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "aggressive",
  darkMode: false
};

const elements = {
  enabled: /** @type {HTMLInputElement} */ (document.getElementById("enabledToggle")),
  mode: /** @type {HTMLSelectElement} */ (document.getElementById("modeSelect")),
  darkMode: /** @type {HTMLInputElement} */ (document.getElementById("darkModeToggle")),
  toast: /** @type {HTMLDivElement} */ (document.getElementById("saveToast")),
  debugContent: /** @type {HTMLDivElement} */ (document.getElementById("debugContent")),
  refreshDebugBtn: /** @type {HTMLButtonElement} */ (document.getElementById("refreshDebugBtn"))
};

let toastTimer = null;

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} data
 * @returns {{enabled: boolean, mode: string, darkMode: boolean}}
 */
function normalizeSettings(data) {
  let mode = DEFAULT_SETTINGS.mode;
  if (data.mode === "normal" || data.mode === "aggressive" || data.mode === "ultra") {
    mode = data.mode;
  } else if (typeof data.aggressiveMode === "boolean") {
    mode = data.aggressiveMode ? "aggressive" : "normal";
  }

  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled,
    mode,
    darkMode: typeof data.darkMode === "boolean" ? data.darkMode : DEFAULT_SETTINGS.darkMode
  };
}

/**
 * @param {{enabled: boolean, mode: string, darkMode: boolean}} settings
 */
function applySettingsToUi(settings) {
  elements.enabled.checked = settings.enabled;
  elements.mode.value = settings.mode;
  elements.darkMode.checked = settings.darkMode;
  document.body.classList.toggle("dark", settings.darkMode);
}

function getSettingsFromUi() {
  return {
    enabled: elements.enabled.checked,
    mode: elements.mode.value,
    darkMode: elements.darkMode.checked
  };
}

function showSavedToast() {
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  elements.toast.classList.add("show");
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 900);
}

async function sendSettingsToActiveTab(settings) {
  let activeTabId = null;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && Number.isInteger(tabs[0].id)) {
      activeTabId = tabs[0].id;
    }
  } catch (_error) {
    return;
  }

  if (activeTabId === null) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: "ECP_UPDATE_SETTINGS",
      settings
    });
  } catch (_error) {
    // Expected on restricted pages or pages where content script is unavailable.
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && Number.isInteger(tabs[0].id)) {
    return tabs[0].id;
  }
  return null;
}

function renderDebugStatus(status) {
  if (!status) {
    elements.debugContent.textContent = "No debug data available for this tab.";
    return;
  }

  const lines = [
    `Mode: ${status.mode}`,
    `Enabled: ${status.enabled ? "Yes" : "No"}`,
    `Canvas detected: ${status.blockerSignals.canvasDetected ? "Yes" : "No"}`,
    `Iframes: ${status.blockerSignals.iframeCount}`,
    `Cross-origin iframes: ${status.blockerSignals.crossOriginIframeCount}`,
    `Shadow roots found: ${status.blockerSignals.shadowRootCount}`,
    `Overrides: ${
      status.overridesApplied && status.overridesApplied.length > 0
        ? status.overridesApplied.join(", ")
        : "None"
    }`,
    `Last applied: ${status.lastAppliedAt ? new Date(status.lastAppliedAt).toLocaleTimeString() : "N/A"}`
  ];
  elements.debugContent.textContent = lines.join("\n");
}

async function refreshDebugPanel() {
  elements.debugContent.textContent = "Checking current tab...";
  try {
    const tabId = await getActiveTabId();
    if (tabId === null) {
      elements.debugContent.textContent = "No active tab detected.";
      return;
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: "ECP_GET_DEBUG_STATUS"
    });
    if (response && response.ok) {
      renderDebugStatus(response.status);
      return;
    }
    elements.debugContent.textContent = "Debug endpoint unavailable on this page.";
  } catch (_error) {
    elements.debugContent.textContent =
      "Cannot read page debug status (restricted page or script not loaded).";
  }
}

async function persistSettings(settings) {
  await chrome.storage.sync.set(settings);
  await sendSettingsToActiveTab(settings);
}

async function initializePopup() {
  try {
    const stored = await chrome.storage.sync.get(["enabled", "mode", "darkMode", "aggressiveMode"]);
    const normalized = normalizeSettings(stored);
    applySettingsToUi(normalized);

    // Back-fill missing keys for consistent behavior across tabs/sessions.
    await chrome.storage.sync.set(normalized);
  } catch (error) {
    console.warn("[ECP] Failed to initialize popup settings:", error);
    applySettingsToUi(DEFAULT_SETTINGS);
  }

  await refreshDebugPanel();
}

async function handleToggleChange() {
  const settings = getSettingsFromUi();
  document.body.classList.toggle("dark", settings.darkMode);

  try {
    await persistSettings(settings);
    showSavedToast();
    await refreshDebugPanel();
  } catch (error) {
    console.warn("[ECP] Failed to save settings:", error);
  }
}

elements.enabled.addEventListener("change", handleToggleChange);
elements.mode.addEventListener("change", handleToggleChange);
elements.darkMode.addEventListener("change", handleToggleChange);
elements.refreshDebugBtn.addEventListener("click", refreshDebugPanel);

initializePopup();
