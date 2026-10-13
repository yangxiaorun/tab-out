/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Keeps the toolbar badge updated and owns todo storage and GitHub sync.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

importScripts('priority-store.js', 'priority-sync.js');

const priorityStore = new PriorityStore.Store(chrome.storage.local);
const prioritySync = new PrioritySync.GitHubSync(priorityStore, chrome.storage.local);
let priorityQueue = Promise.resolve();
let syncTimer;
let lastSyncAttempt = 0;
const SYNC_ALARM = 'priority-github-sync';

function queuePriority(operation) {
  const result = priorityQueue.then(operation);
  priorityQueue = result.catch(() => {});
  return result;
}

function schedulePrioritySync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    queuePriority(() => {
      lastSyncAttempt = Date.now();
      return prioritySync.run();
    }).catch(() => {});
  }, 1500);
}

async function ensureSyncAlarm() {
  const alarm = await chrome.alarms.get(SYNC_ALARM);
  if (!alarm) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== 'priority') return;
  // Only this extension's own pages may issue todo operations.
  if (sender.id !== chrome.runtime.id ||
      (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) return;
  let operation;
  if (message.action === 'sync-status') {
    operation = prioritySync.status();
  } else if (message.action === 'dispatch') {
    // Network sync must never block local edits, even while offline.
    operation = priorityStore.dispatch(message.operation || {}).then(async result => {
      if (message.operation?.type !== 'state') {
        await prioritySync.markPending();
        schedulePrioritySync();
      }
      return result;
    });
  } else {
    operation = queuePriority(async () => {
      if (message.action === 'sync-keychain') {
        let reply;
        try {
          reply = await chrome.runtime.sendNativeMessage('com.tab_out.github_keychain', { action: 'bootstrap' });
        } catch {
          throw new Error('Install the Mac Keychain helper first: python3 scripts/github-todo-host.py --install');
        }
        if (!reply?.ok) throw new Error(reply?.error || 'Could not connect GitHub from Keychain.');
        const result = await prioritySync.configure(reply.config);
        await ensureSyncAlarm();
        return result;
      }
      if (message.action === 'sync-configure') {
        const result = await prioritySync.configure(message.config || {});
        await ensureSyncAlarm();
        return result;
      }
      if (message.action === 'sync-disconnect') return prioritySync.disconnect();
      if (message.action === 'sync-now') {
        lastSyncAttempt = Date.now();
        return prioritySync.run();
      }
      if (message.action === 'sync-wake') {
        if (Date.now() - lastSyncAttempt > 30000) {
          lastSyncAttempt = Date.now();
          return prioritySync.run();
        }
        return prioritySync.status();
      }
      throw new Error('Unknown priority action');
    });
  }
  operation.then(data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== SYNC_ALARM) return;
  queuePriority(() => {
    lastSyncAttempt = Date.now();
    return prioritySync.run();
  }).catch(() => {});
});

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  ensureSyncAlarm();
  schedulePrioritySync();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  ensureSyncAlarm();
  schedulePrioritySync();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
ensureSyncAlarm();
