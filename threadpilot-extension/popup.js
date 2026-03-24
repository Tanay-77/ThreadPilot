/**
 * ThreadPilot — Popup Script
 * Detects if the current tab is a supported AI platform (ChatGPT, Gemini, Claude)
 * and communicates with the content script to open/refresh the sidebar.
 */

const SUPPORTED_ORIGINS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'claude.ai',
];

/**
 * Checks whether a given URL is a supported AI chat page.
 */
function isSupportedPlatform(url) {
  try {
    const hostname = new URL(url).hostname;
    return SUPPORTED_ORIGINS.some(origin => hostname === origin || hostname.endsWith('.' + origin));
  } catch {
    return false;
  }
}

/**
 * Updates the popup UI based on whether we're on ChatGPT.
 */
function updateUI(onChatGPT) {
  const mainContent = document.getElementById('main-content');
  const actions = document.getElementById('actions');
  const shortcut = document.getElementById('shortcut');
  const notChatGPT = document.getElementById('not-chatgpt');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  if (onChatGPT) {
    mainContent.style.display = '';
    actions.style.display = '';
    shortcut.style.display = '';
    notChatGPT.style.display = 'none';

    statusDot.classList.add('active');
    statusText.textContent = 'Active on this page';
  } else {
    mainContent.style.display = 'none';
    actions.style.display = 'none';
    shortcut.style.display = 'none';
    notChatGPT.style.display = 'block';
  }
}

/**
 * Sends a message to the content script on the active tab.
 */
async function sendToContentScript(tabId, action) {
  try {
    await chrome.tabs.sendMessage(tabId, { action });
  } catch (err) {
    // Content script may not be ready yet — log silently
    console.warn('[ThreadPilot popup] Could not reach content script:', err.message);
  }
}

// ── Main ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Query the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url) {
    updateUI(false);
    return;
  }

  const onSupportedPlatform = isSupportedPlatform(tab.url);
  updateUI(onSupportedPlatform);

  if (!onSupportedPlatform) return;

  // ── Button handlers ─────────────────────────────────────────

  document.getElementById('btn-open').addEventListener('click', async () => {
    await sendToContentScript(tab.id, 'open-sidebar');
    window.close(); // close the popup after triggering
  });

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await sendToContentScript(tab.id, 'refresh-sidebar');
    window.close();
  });
});
