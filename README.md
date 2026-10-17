# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Close tabs with a satisfying swoosh + confetti.

No server. Runs locally, with optional private GitHub sync for daily todos.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Daily priorities** add, edit, reorder, and complete todos; unfinished work stays on the next day's board
- **Private GitHub sync** share todos across devices using a separate private repository
- **Permanent todo history** retain plan times, completion times, and subsequent changes for future review
- **Local by default** tabs and saved links stay on your device; only todos leave it when you connect GitHub
- **Pure Chrome extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## How it works

```
You open a new tab
  -> Tab Out shows your open tabs grouped by domain
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. Saved tabs are stored in `chrome.storage.local`. Optional todo sync calls GitHub directly; it does not require a server.

## Todo sync setup

Reload the updated extension in `chrome://extensions`. Version 1.1 adds GitHub API, background alarms, native messaging, and local unlimited-storage permissions.

On this Mac, the optional Keychain helper can create the dedicated repository `yangxiaorun/tab-out-todo-private` and connect using the existing GitHub PAT:

```bash
python3 scripts/github-todo-host.py --install
```

The installer copies the helper to `~/Library/Application Support/Tab Out/`, so moving or updating this code repository does not break Chrome's native-host registration. Restart Chrome after installation, then open a new Tab Out tab, select **Sync settings**, and click **Use this Mac's GitHub key**. The helper reads the internet-password entry for `github.com` / `yangxiaorun`. It verifies the account and requires a private repository. It never prints or writes the token to files. If Chrome's extension ID cannot be detected, add `--extension-id <ID>` from the extensions page.

On another device, load the extension and configure **Sync settings** with the same private repository and a GitHub fine-grained token scoped to that repository, with **Contents: read and write**. Initialize a manually created repository with a README. Tokens are stored in local extension storage, never in Chrome sync or GitHub commits. You can use a separate token on each device.

The board saves edits locally before any network operation. The background worker syncs shortly after edits, at browser startup, on opening/focusing Tab Out, and once per minute while Chrome is running. Offline changes retry automatically. **Sync now** requests an immediate update. Only todo history is uploaded; tab URLs, saved links, and credentials are excluded.

Privacy is checked on every synchronization. If the repository becomes public or authorization fails, sync stops and local editing continues. Private GitHub storage is access controlled, not end-to-end encrypted; GitHub and authorized repository members can read the records.

## Todo history format

The separate data repository contains `todo/history.json`, a UTF-8 document with `schemaVersion: 1` and an append-only `events` array. Each event includes:

| Field | Meaning |
|-------|---------|
| `id`, `taskId` | Unique operation ID and stable task identity |
| `type` | `created`, `completed`, `reopened`, `edited`, `deleted`, `reordered`, or `imported` |
| `at` | ISO UTC time of the operation |
| `date`, `utcOffsetMinutes` | Device-local calendar date and UTC offset at the operation |
| `deviceId`, `clock` | Device identity and logical ordering for deterministic merges |
| `data` | Initial plan/title or changed fields |

A `created` event stores the original title, `createdAt`, plan `date`, and `originalPlannedDate`. A `completed` event preserves the exact completion click time. Reopening or deleting does not remove earlier completion events. Deleting hides a task and retains its history. Unfinished tasks keep the same ID and original creation time across days; completed tasks leave the daily board after their completion day.

Existing local `priorityTasks` are imported once, with their saved timestamps; the original local array is retained as a migration backup. Old carryover copies remain separate archival records because their previous format did not retain parent IDs. Previously deleted tasks and earlier completion clicks overwritten by the old implementation cannot be recovered. Missing legacy timestamps are marked as legacy and are not represented as exact historical click times.

Devices merge event IDs, then retry GitHub SHA conflicts rather than overwrite another device's history. Independent fields merge independently. Simultaneous changes to the same field use a deterministic logical-clock/device-ID ordering; all events remain available. Deletion wins over later edits. History is retained without automatic pruning; raw blob downloads support GitHub files above the 1 MB inline-content threshold. GitHub's API/file limits still apply.

Disconnecting removes the local sync credential and keeps both local and remote todo history. Connecting a different repository uploads/merges the local history into it. No statistics or analytics UI is implemented.

## Verification

Runtime does not need Node.js or npm. Developers can run the storage, merge, background, privacy, and transport tests with:

```bash
node --test tests/priority-sync.test.js
```

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Optional todo sync | GitHub Contents API + background alarms |
| Optional Mac authorization | Python native-messaging helper + macOS Keychain |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
