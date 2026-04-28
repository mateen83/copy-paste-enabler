"use strict";

const STORAGE_KEYS = ["enabled", "aggressiveMode", "darkMode"];

const DEFAULT_SETTINGS = {
  enabled: true,
  aggressiveMode: true,
  darkMode: false
};

const GUARDED_EVENTS = ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart"];

let currentSettings = { ...DEFAULT_SETTINGS };
let domObserver = null;
let selectionStyleTag = null;
let listenersAttached = false;
let pageGuardInjected = false;

/**
 * Normalizes data from storage into safe, explicit booleans.
 * @param {Partial<typeof DEFAULT_SETTINGS>} stored
 * @returns {{enabled: boolean, aggressiveMode: boolean, darkMode: boolean}}
 */
function normalizeSettings(stored) {
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.enabled,
    aggressiveMode:
      typeof stored.aggressiveMode === "boolean"
        ? stored.aggressiveMode
        : DEFAULT_SETTINGS.aggressiveMode,
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

  // Keep default browser action intact, only block page scripts from interfering.
  event.stopImmediatePropagation();
}

function attachGuards() {
  if (listenersAttached) {
    return;
  }

  const options = { capture: true, passive: false };

  for (const eventName of GUARDED_EVENTS) {
    window.addEventListener(eventName, guardClipboardEvent, options);
    document.addEventListener(eventName, guardClipboardEvent, options);
  }

  window.addEventListener("keydown", guardClipboardEvent, options);
  document.addEventListener("keydown", guardClipboardEvent, options);

  listenersAttached = true;
}

function detachGuards() {
  if (!listenersAttached) {
    return;
  }

  const options = { capture: true };

  for (const eventName of GUARDED_EVENTS) {
    window.removeEventListener(eventName, guardClipboardEvent, options);
    document.removeEventListener(eventName, guardClipboardEvent, options);
  }

  window.removeEventListener("keydown", guardClipboardEvent, options);
  document.removeEventListener("keydown", guardClipboardEvent, options);

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

function removeSelectionStyle() {
  if (selectionStyleTag && selectionStyleTag.parentNode) {
    selectionStyleTag.parentNode.removeChild(selectionStyleTag);
  }
  selectionStyleTag = null;
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

    if (currentSettings.aggressiveMode) {
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

function injectPageGuardIfNeeded() {
  if (pageGuardInjected) {
    return;
  }

  const script = document.createElement("script");
  script.textContent = `
    (() => {
      const NAMESPACE = "__ECP_PAGE_GUARD__";
      if (window[NAMESPACE] && window[NAMESPACE].initialized) {
        return;
      }

      const blockedTypes = new Set(["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart", "keydown"]);
      const originalAdd = EventTarget.prototype.addEventListener;
      const originalRemove = EventTarget.prototype.removeEventListener;
      const listenerMap = new WeakMap();
      const optionsMap = new WeakMap();

      const state = {
        initialized: true,
        enabled: true,
        aggressiveMode: true
      };

      function shouldProtectKeyboardEvent(event) {
        if (!event || event.type !== "keydown") {
          return true;
        }

        const key = String(event.key || "").toLowerCase();
        const hasModifier = event.ctrlKey || event.metaKey;
        return hasModifier && (key === "c" || key === "v" || key === "x" || key === "a" || key === "insert");
      }

      function createWrappedListener(type, listener) {
        if (typeof listener !== "function") {
          return listener;
        }

        if (!blockedTypes.has(type)) {
          return listener;
        }

        const wrapped = function(event) {
          if (!state.enabled || !state.aggressiveMode) {
            return listener.call(this, event);
          }

          if (!shouldProtectKeyboardEvent(event)) {
            return listener.call(this, event);
          }

          const originalPreventDefault = event.preventDefault;
          const originalStopPropagation = event.stopPropagation;
          const originalStopImmediatePropagation = event.stopImmediatePropagation;

          event.preventDefault = function() {};
          event.stopPropagation = function() {};
          event.stopImmediatePropagation = function() {};

          try {
            return listener.call(this, event);
          } finally {
            event.preventDefault = originalPreventDefault;
            event.stopPropagation = originalStopPropagation;
            event.stopImmediatePropagation = originalStopImmediatePropagation;
          }
        };

        listenerMap.set(listener, wrapped);
        return wrapped;
      }

      EventTarget.prototype.addEventListener = function(type, listener, options) {
        try {
          const wrapped = createWrappedListener(type, listener);
          if (listener !== wrapped) {
            optionsMap.set(listener, options);
          }
          return originalAdd.call(this, type, wrapped, options);
        } catch (_error) {
          return originalAdd.call(this, type, listener, options);
        }
      };

      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const mapped = listenerMap.get(listener) || listener;
        const resolvedOptions = options !== undefined ? options : optionsMap.get(listener);
        return originalRemove.call(this, type, mapped, resolvedOptions);
      };

      function clearPageInlineHandlers() {
        if (!state.enabled) {
          return;
        }

        const targets = [window, document, document.documentElement, document.body];
        for (const target of targets) {
          if (!target) {
            continue;
          }

          try {
            target.oncopy = null;
            target.oncut = null;
            target.onpaste = null;
            target.oncontextmenu = null;
            target.onselectstart = null;
            target.ondragstart = null;
            target.onkeydown = null;
          } catch (_error) {}
        }
      }

      window.addEventListener("ECP_PAGE_GUARD_UPDATE", (event) => {
        const detail = event && event.detail ? event.detail : {};
        state.enabled = Boolean(detail.enabled);
        state.aggressiveMode = Boolean(detail.aggressiveMode);
        clearPageInlineHandlers();
      }, true);

      window[NAMESPACE] = state;
    })();
  `;

  (document.documentElement || document.head || document).appendChild(script);
  script.remove();
  pageGuardInjected = true;
}

function notifyPageGuard() {
  const event = new CustomEvent("ECP_PAGE_GUARD_UPDATE", {
    detail: {
      enabled: currentSettings.enabled,
      aggressiveMode: currentSettings.aggressiveMode
    }
  });
  window.dispatchEvent(event);
}

function applySettings() {
  if (!currentSettings.enabled) {
    detachGuards();
    stopDomObserver();
    removeSelectionStyle();
    notifyPageGuard();
    return;
  }

  attachGuards();
  neutralizeKnownInlineHandlers();
  startDomObserver();

  if (currentSettings.aggressiveMode) {
    injectPageGuardIfNeeded();
    ensureSelectionStyle();
  } else {
    removeSelectionStyle();
  }

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
