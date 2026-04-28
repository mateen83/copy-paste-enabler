"use strict";

/**
 * Sends a settings refresh request to a specific tab.
 * Errors are expected on restricted pages and are handled silently.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function notifyTabToRefresh(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "ECP_REFRESH_SETTINGS"
    });
  } catch (error) {
    // Common for chrome:// pages, PDF viewer, Web Store, or if script not injected.
    // Keep extension stable by swallowing known sendMessage failures.
    if (error && typeof error.message === "string") {
      const isExpectedError =
        error.message.includes("Receiving end does not exist") ||
        error.message.includes("Could not establish connection") ||
        error.message.includes("The message port closed");

      if (!isExpectedError) {
        console.warn("[ECP] Failed to notify tab:", tabId, error.message);
      }
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    notifyTabToRefresh(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "ECP_BROADCAST_REFRESH") {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      Promise.allSettled(tabs.map((tab) => notifyTabToRefresh(tab.id)))
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    });

    return true;
  }
});
