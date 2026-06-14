// =============================================================================
// background.js — Service Worker (Manifest V3)
// =============================================================================
// This service worker acts as a message router between the content script
// (running on the chess page) and the offscreen document (hosting Stockfish).
//
// Architecture:
//   Content Script  ←→  Background SW  ←→  Offscreen Document  ←→  Stockfish Worker
//
// Message types:
//   ANALYZE_FEN    — content script → offscreen (via background)
//   ENGINE_RESULT  — offscreen → content script (via background)
//   STOP_ENGINE    — content script → offscreen (via background)
// =============================================================================

/**
 * Track whether we've already created the offscreen document.
 * Chrome only allows one offscreen document per extension at a time.
 */
let offscreenDocumentCreated = false;

/**
 * The tab ID of the content script that requested analysis.
 * NOTE: This is in-memory and WILL be lost when the service worker restarts.
 * All forwarding code has a fallback broadcast path for when this is null.
 */
let activeAnalysisTabId = null;

// -----------------------------------------------------------------------------
// Offscreen Document Lifecycle
// -----------------------------------------------------------------------------

/**
 * Ensures the offscreen document exists. Creates it lazily on first use.
 * The offscreen document hosts the Stockfish Web Worker.
 */
async function ensureOffscreenDocument() {
  if (offscreenDocumentCreated) return;

  // Check if one already exists (e.g., after service worker restart)
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      return;
    }
  } catch (e) {
    // getContexts may not be available in older Chrome; fall through
  }

  // Create the offscreen document
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run Stockfish WASM engine in a Web Worker for chess analysis',
    });
  } catch (e) {
    // "Only a single offscreen document may be created" — already exists
    if (!e.message?.includes('single offscreen')) {
      console.error('[Chess Assistant] Failed to create offscreen document:', e);
      return;
    }
  }

  offscreenDocumentCreated = true;
  console.log('[Chess Assistant] Offscreen document created.');
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Send a message to the offscreen document with retry.
 * The offscreen document's scripts may not have loaded when the document is
 * first created, so we retry a few times with a delay.
 */
function sendToOffscreen(msg, retriesLeft = 5) {
  chrome.runtime.sendMessage(msg, (response) => {
    if (chrome.runtime.lastError) {
      if (retriesLeft > 0) {
        console.log(`[Chess Assistant] Offscreen not ready, retrying in 500ms… (${retriesLeft} left)`);
        setTimeout(() => sendToOffscreen(msg, retriesLeft - 1), 500);
      } else {
        console.error('[Chess Assistant] Could not reach offscreen document:', chrome.runtime.lastError.message);
      }
    }
  });
}

/**
 * Forward a message to the chess tab(s).
 * If activeAnalysisTabId is known, sends to that tab.
 * Otherwise broadcasts to ALL chess tabs (handles service worker restart).
 */
function forwardToChessTabs(msg) {
  if (activeAnalysisTabId) {
    chrome.tabs.sendMessage(activeAnalysisTabId, msg, () => {
      if (chrome.runtime.lastError) {
        // Tab may have closed — broadcast as fallback
        broadcastToChessTabs(msg);
      }
    });
  } else {
    broadcastToChessTabs(msg);
  }
}

function broadcastToChessTabs(msg) {
  chrome.tabs.query({ url: ['*://*.chess.com/*', '*://*.lichess.org/*'] }, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg, () => {
        void chrome.runtime.lastError; // suppress "Receiving end does not exist"
      });
    }
  });
}

// -----------------------------------------------------------------------------
// Message Handling
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Determine the source of the message
  const isFromContentScript = sender.tab !== undefined;

  // ── Messages from Content Script ──────────────────────────────────────────
  if (isFromContentScript) {
    if (message.type === 'CONTENT_SCRIPT_READY') {
      activeAnalysisTabId = sender.tab.id;
      ensureOffscreenDocument().then(() => {
        console.log('[Chess Assistant] Content script registered, tab:', sender.tab.id);
      });
      sendResponse({ status: 'registered' });
      return true;
    }

    if (message.type === 'ANALYZE_FEN') {
      // Store the tab ID so we can route results back
      activeAnalysisTabId = sender.tab.id;

      // Forward the FEN analysis request to the offscreen document (with retry)
      ensureOffscreenDocument().then(() => {
        // Small delay to let offscreen.js register its listener on first load
        setTimeout(() => {
          sendToOffscreen({
            type: 'ANALYZE_FEN',
            fen: message.fen,
            depth: message.depth || 18,
            tabId: sender.tab.id,  // pass tabId for round-trip
          });
        }, 100);
      });

      sendResponse({ status: 'forwarded' });
      return true;
    }

    if (message.type === 'STOP_ENGINE') {
      sendToOffscreen({ type: 'STOP_ENGINE' });
      sendResponse({ status: 'stop_forwarded' });
      return true;
    }
  }

  // ── Messages from Offscreen Document ──────────────────────────────────────
  if (!isFromContentScript) {
    if (message.type === 'ENGINE_RESULT') {
      // Recover tabId from the round-trip message if service worker restarted
      if (message.tabId && !activeAnalysisTabId) {
        activeAnalysisTabId = message.tabId;
      }
      forwardToChessTabs({
        type: 'ENGINE_RESULT',
        data: message.data,
      });
      return false;
    }

    if (message.type === 'ENGINE_PROGRESS') {
      if (message.tabId && !activeAnalysisTabId) {
        activeAnalysisTabId = message.tabId;
      }
      forwardToChessTabs({
        type: 'ENGINE_PROGRESS',
        data: message.data,
      });
      return false;
    }

    if (message.type === 'ENGINE_READY') {
      console.log('[Chess Assistant] Stockfish engine is ready.');
      forwardToChessTabs({ type: 'ENGINE_READY' });
      return false;
    }
  }

  return false;
});

// -----------------------------------------------------------------------------
// Extension Icon Click — Toggle UI in the active tab
// -----------------------------------------------------------------------------

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_UI' });
  } catch (err) {
    console.log('[Chess Assistant] Content script not ready, injecting...');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  }
});

console.log('[Chess Assistant] Background service worker loaded.');

// Eagerly create the offscreen document so the engine starts initializing
// immediately, rather than waiting for the first ANALYZE_FEN message.
ensureOffscreenDocument().then(() => {
  console.log('[Chess Assistant] Offscreen document ready (eager init).');
}).catch((err) => {
  console.error('[Chess Assistant] Failed to create offscreen document:', err);
});
