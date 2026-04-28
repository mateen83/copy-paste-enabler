"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  aggressiveMode: true,
  darkMode: false
};

const elements = {
  enabled: /** @type {HTMLInputElement} */ (document.getElementById("enabledToggle")),
  aggressiveMode: /** @type {HTMLInputElement} */ (document.getElementById("aggressiveToggle")),
  darkMode: /** @type {HTMLInputElement} */ (document.getElementById("darkModeToggle")),
  toast: /** @type {HTMLDivElement} */ (document.getElementById("saveToast"))
};

let toastTimer = null;

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} data
 * @returns {{enabled: boolean, aggressiveMode: boolean, darkMode: boolean}}
 */
function normalizeSettings(data) {
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled,
    aggressiveMode:
      typeof data.aggressiveMode === "boolean"
        ? data.aggressiveMode
        : DEFAULT_SETTINGS.aggressiveMode,
    darkMode: typeof data.darkMode === "boolean" ? data.darkMode : DEFAULT_SETTINGS.darkMode
  };
}

/**
 * @param {{enabled: boolean, aggressiveMode: boolean, darkMode: boolean}} settings
 */
function applySettingsToUi(settings) {
  elements.enabled.checked = settings.enabled;
  elements.aggressiveMode.checked = settings.aggressiveMode;
  elements.darkMode.checked = settings.darkMode;
  document.body.classList.toggle("dark", settings.darkMode);
}

function getSettingsFromUi() {
  return {
    enabled: elements.enabled.checked,
    aggressiveMode: elements.aggressiveMode.checked,
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

async function persistSettings(settings) {
  await chrome.storage.sync.set(settings);
  await sendSettingsToActiveTab(settings);
}

async function initializePopup() {
  try {
    const stored = await chrome.storage.sync.get(["enabled", "aggressiveMode", "darkMode"]);
    const normalized = normalizeSettings(stored);
    applySettingsToUi(normalized);

    // Back-fill missing keys for consistent behavior across tabs/sessions.
    await chrome.storage.sync.set(normalized);
  } catch (error) {
    console.warn("[ECP] Failed to initialize popup settings:", error);
    applySettingsToUi(DEFAULT_SETTINGS);
  }
}

async function handleToggleChange() {
  const settings = getSettingsFromUi();
  document.body.classList.toggle("dark", settings.darkMode);

  try {
    await persistSettings(settings);
    showSavedToast();
  } catch (error) {
    console.warn("[ECP] Failed to save settings:", error);
  }
}

elements.enabled.addEventListener("change", handleToggleChange);
elements.aggressiveMode.addEventListener("change", handleToggleChange);
elements.darkMode.addEventListener("change", handleToggleChange);

initializePopup();
