"use strict";

const STORAGE_KEYS = ["enabled", "mode", "darkMode", "aggressiveMode"];

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "aggressive",
  darkMode: false
};

const MODES = {
  NORMAL: "normal",
  AGGRESSIVE: "aggressive",
  ULTRA: "ultra"
};

const BASE_EVENTS = [
  "copy",
  "cut",
  "paste",
  "contextmenu",
  "selectstart",
  "dragstart",
  "keydown",
  "keypress",
  "keyup"
];
const ULTRA_EXTRA_EVENTS = ["mousedown", "mouseup"];

let currentSettings = { ...DEFAULT_SETTINGS };
let domObserver = null;
let selectionStyleTag = null;
let overlayStyleTag = null;
let listenersAttached = false;
let pageGuardInjected = false;
let rebindingIntervalId = null;

const debugState = {
  mode: DEFAULT_SETTINGS.mode,
  enabled: DEFAULT_SETTINGS.enabled,
  overridesApplied: [],
  blockerSignals: {
    canvasDetected: false,
    iframeCount: 0,
    crossOriginIframeCount: 0,
    shadowRootCount: 0
  },
  lastAppliedAt: null
};

function getActiveEventsByMode() {
  if (currentSettings.mode === MODES.ULTRA) {
    return [...BASE_EVENTS, ...ULTRA_EXTRA_EVENTS];
  }
  if (currentSettings.mode === MODES.AGGRESSIVE) {
    return BASE_EVENTS;
  }
  return ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart", "keydown"];
}

function updateDebugState(overridesApplied) {
  const canvases = document.querySelectorAll("canvas");
  const iframes = document.querySelectorAll("iframe");
  let crossOriginIframeCount = 0;

  for (const iframe of iframes) {
    try {
      if (iframe.contentWindow && iframe.contentWindow.location.origin !== window.location.origin) {
        crossOriginIframeCount += 1;
      }
    } catch (_error) {
      crossOriginIframeCount += 1;
    }
  }

  debugState.mode = currentSettings.mode;
  debugState.enabled = currentSettings.enabled;
  debugState.overridesApplied = overridesApplied;
  debugState.blockerSignals.canvasDetected = canvases.length > 0;
  debugState.blockerSignals.iframeCount = iframes.length;
  debugState.blockerSignals.crossOriginIframeCount = crossOriginIframeCount;
  debugState.lastAppliedAt = new Date().toISOString();
}

/**
 * Normalizes data from storage into safe, explicit booleans.
 * @param {Partial<typeof DEFAULT_SETTINGS>} stored
 * @returns {{enabled: boolean, mode: string, darkMode: boolean}}
 */
function normalizeSettings(stored) {
  let mode = DEFAULT_SETTINGS.mode;
  if (stored.mode === MODES.NORMAL || stored.mode === MODES.AGGRESSIVE || stored.mode === MODES.ULTRA) {
    mode = stored.mode;
  } else if (typeof stored.aggressiveMode === "boolean") {
    mode = stored.aggressiveMode ? MODES.AGGRESSIVE : MODES.NORMAL;
  }

  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.enabled,
    mode,
    darkMode: typeof stored.darkMode === "boolean" ? stored.darkMode : DEFAULT_SETTINGS.darkMode
  };
}

/**
 * Capture-phase guard that blocks hostile listeners while allowing browser defaults.
 * @param {Event} event
 */
function guardClipboardEvent(event) {
  if (!currentSettings.enabled) {
    return;
  }

  if (event.type === "keydown") {
    const keyboardEvent = /** @type {KeyboardEvent} */ (event);
    const hasModifier = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
    if (!hasModifier) {
      return;
    }

    const key = (keyboardEvent.key || "").toLowerCase();
    const isTargetShortcut = key === "c" || key === "v" || key === "x" || key === "a" || key === "insert";
    if (!isTargetShortcut) {
      return;
    }
  }

  if (currentSettings.mode === MODES.NORMAL && event.type !== "keydown") {
    return;
  }

  // Keep default browser action intact; block page scripts from interference.
  event.stopImmediatePropagation();
}

function attachGuards() {
  if (listenersAttached) {
    return;
  }

  const options = { capture: true, passive: false };

  const activeEvents = getActiveEventsByMode();
  for (const eventName of activeEvents) {
    window.addEventListener(eventName, guardClipboardEvent, options);
    document.addEventListener(eventName, guardClipboardEvent, options);
  }

  listenersAttached = true;
}

function detachGuards() {
  if (!listenersAttached) {
    return;
  }

  const options = { capture: true };

  const activeEvents = [...BASE_EVENTS, ...ULTRA_EXTRA_EVENTS];
  for (const eventName of activeEvents) {
    window.removeEventListener(eventName, guardClipboardEvent, options);
    document.removeEventListener(eventName, guardClipboardEvent, options);
  }

  listenersAttached = false;
}

function clearInlineBlockingHandlers(node) {
  if (!(node instanceof Element) && node !== document && node !== window) {
    return;
  }

  const handlerProperties = [
    "oncopy",
    "oncut",
    "onpaste",
    "oncontextmenu",
    "onselectstart",
    "ondragstart",
    "onkeydown"
  ];

  for (const prop of handlerProperties) {
    try {
      if (node && prop in node) {
        node[prop] = null;
      }
    } catch (_error) {
      // Some nodes expose read-only handlers; ignore safely.
    }
  }

  if (node instanceof Element) {
    try {
      node.removeAttribute("oncopy");
      node.removeAttribute("oncut");
      node.removeAttribute("onpaste");
      node.removeAttribute("oncontextmenu");
      node.removeAttribute("onselectstart");
      node.removeAttribute("ondragstart");
      node.removeAttribute("onkeydown");
      node.style.setProperty("user-select", "text", "important");
      node.style.setProperty("-webkit-user-select", "text", "important");
    } catch (_error) {
      // Ignore locked/custom elements.
    }
  }
}

function neutralizeKnownInlineHandlers() {
  clearInlineBlockingHandlers(window);
  clearInlineBlockingHandlers(document);
  clearInlineBlockingHandlers(document.documentElement);
  clearInlineBlockingHandlers(document.body);
}

function ensureSelectionStyle() {
  if (selectionStyleTag || !document.documentElement) {
    return;
  }

  selectionStyleTag = document.createElement("style");
  selectionStyleTag.id = "ecp-force-selection-style";
  selectionStyleTag.textContent =
    "* { user-select: text !important; -webkit-user-select: text !important; }";
  (document.head || document.documentElement).appendChild(selectionStyleTag);
}

function ensureOverlayStyle() {
  if (overlayStyleTag || !document.documentElement) {
    return;
  }

  overlayStyleTag = document.createElement("style");
  overlayStyleTag.id = "ecp-overlay-style";
  overlayStyleTag.textContent =
    "* { user-select: text !important; -webkit-user-select: text !important; pointer-events: auto !important; }";
  (document.head || document.documentElement).appendChild(overlayStyleTag);
}

function removeSelectionStyle() {
  if (selectionStyleTag && selectionStyleTag.parentNode) {
    selectionStyleTag.parentNode.removeChild(selectionStyleTag);
  }
  selectionStyleTag = null;
}

function removeOverlayStyle() {
  if (overlayStyleTag && overlayStyleTag.parentNode) {
    overlayStyleTag.parentNode.removeChild(overlayStyleTag);
  }
  overlayStyleTag = null;
}

function pierceShadow(root) {
  if (!root || !(root instanceof Document || root instanceof ShadowRoot || root instanceof Element)) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.shadowRoot) {
      debugState.blockerSignals.shadowRootCount += 1;
      clearInlineBlockingHandlers(node.shadowRoot.host);
      pierceShadow(node.shadowRoot);
    }
    node = walker.nextNode();
  }
}

function clearBlockingClasses() {
  const classNames = ["no-copy", "no-select", "disable-copy", "disable-select", "prevent-copy"];
  if (document.body) {
    document.body.classList.remove(...classNames);
  }
  if (document.documentElement) {
    document.documentElement.classList.remove(...classNames);
  }
}

function startDomObserver() {
  if (domObserver || !document.documentElement) {
    return;
  }

  domObserver = new MutationObserver((mutations) => {
    if (!currentSettings.enabled) {
      return;
    }

    neutralizeKnownInlineHandlers();
    clearBlockingClasses();
    pierceShadow(document);

    if (currentSettings.mode !== MODES.NORMAL) {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          clearInlineBlockingHandlers(mutation.target);
        }

        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            clearInlineBlockingHandlers(node);

            const descendants = node.querySelectorAll("*");
            for (const element of descendants) {
              clearInlineBlockingHandlers(element);
            }
          }
        }
      }
    }
  });

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "oncopy",
      "oncut",
      "onpaste",
      "oncontextmenu",
      "onselectstart",
      "ondragstart",
      "onkeydown",
      "style"
    ]
  });
}

function stopDomObserver() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
}

function startRebindingDefenseLoop() {
  if (rebindingIntervalId || currentSettings.mode !== MODES.ULTRA) {
    return;
  }

  rebindingIntervalId = window.setInterval(() => {
    if (!currentSettings.enabled || currentSettings.mode !== MODES.ULTRA) {
      return;
    }
    neutralizeKnownInlineHandlers();
    clearBlockingClasses();
  }, 1000);
}

function stopRebindingDefenseLoop() {
  if (rebindingIntervalId) {
    window.clearInterval(rebindingIntervalId);
    rebindingIntervalId = null;
  }
}

function injectPageGuardIfNeeded() {
  if (pageGuardInjected) {
    return;
  }

  if (!document.documentElement) {
    return;
  }

  const existingScript = document.getElementById("ecp-page-guard-script");
  if (existingScript) {
    pageGuardInjected = true;
    return;
  }

  const script = document.createElement("script");
  script.id = "ecp-page-guard-script";
  script.src = chrome.runtime.getURL("page-guard.js");
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  script.onerror = () => {
    console.warn("[ECP] Failed to load page guard script.");
    script.remove();
    pageGuardInjected = false;
  };

  document.documentElement.appendChild(script);
  pageGuardInjected = true;
}

function notifyPageGuard() {
  const event = new CustomEvent("ECP_PAGE_GUARD_UPDATE", {
    detail: {
      enabled: currentSettings.enabled,
      mode: currentSettings.mode
    }
  });
  window.dispatchEvent(event);
}

function applySettings() {
  const overridesApplied = [];

  if (!currentSettings.enabled) {
    detachGuards();
    stopDomObserver();
    stopRebindingDefenseLoop();
    removeSelectionStyle();
    removeOverlayStyle();
    notifyPageGuard();
    updateDebugState([]);
    return;
  }

  // Rebind listeners by current mode.
  detachGuards();
  attachGuards();
  overridesApplied.push("capture-event-guards");
  neutralizeKnownInlineHandlers();
  overridesApplied.push("inline-handler-neutralization");
  startDomObserver();
  overridesApplied.push("mutation-observer-self-healing");
  clearBlockingClasses();
  pierceShadow(document);
  overridesApplied.push("shadow-dom-piercing");

  if (currentSettings.mode === MODES.AGGRESSIVE || currentSettings.mode === MODES.ULTRA) {
    injectPageGuardIfNeeded();
    overridesApplied.push("page-context-event-monkey-patch");
    ensureSelectionStyle();
    overridesApplied.push("forced-selection-style");
  } else {
    removeSelectionStyle();
  }

  if (currentSettings.mode === MODES.ULTRA) {
    ensureOverlayStyle();
    startRebindingDefenseLoop();
    overridesApplied.push("pointer-events-css-override");
    overridesApplied.push("anti-rebinding-defense-loop");
  } else {
    removeOverlayStyle();
    stopRebindingDefenseLoop();
  }

  updateDebugState(overridesApplied);
  notifyPageGuard();
}

async function refreshSettingsFromStorage() {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEYS);
    currentSettings = normalizeSettings(stored);
    applySettings();
  } catch (error) {
    console.warn("[ECP] Failed to read settings, using defaults.", error);
    currentSettings = { ...DEFAULT_SETTINGS };
    applySettings();
  }
}

function updateSettings(partialSettings) {
  currentSettings = normalizeSettings({
    ...currentSettings,
    ...partialSettings
  });
  applySettings();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "ECP_UPDATE_SETTINGS" && message.settings) {
    updateSettings(message.settings);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "ECP_REFRESH_SETTINGS") {
    refreshSettingsFromStorage()
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });

    return true;
  }

  if (message.type === "ECP_GET_DEBUG_STATUS") {
    sendResponse({
      ok: true,
      status: debugState
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  const incoming = {};
  let hasChanges = false;

  for (const key of STORAGE_KEYS) {
    if (changes[key]) {
      incoming[key] = changes[key].newValue;
      hasChanges = true;
    }
  }

  if (hasChanges) {
    updateSettings(incoming);
  }
});

refreshSettingsFromStorage();
