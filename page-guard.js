"use strict";

(() => {
  const NAMESPACE = "__ECP_PAGE_GUARD__";
  if (window[NAMESPACE] && window[NAMESPACE].initialized) {
    return;
  }

  const blockedTypes = new Set([
    "copy",
    "cut",
    "paste",
    "contextmenu",
    "selectstart",
    "dragstart",
    "keydown"
  ]);
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
      } catch (_error) {
        // Ignore readonly objects on hardened pages.
      }
    }
  }

  window.addEventListener(
    "ECP_PAGE_GUARD_UPDATE",
    (event) => {
      const detail = event && event.detail ? event.detail : {};
      state.enabled = Boolean(detail.enabled);
      state.aggressiveMode = Boolean(detail.aggressiveMode);
      clearPageInlineHandlers();
    },
    true
  );

  window[NAMESPACE] = state;
})();
