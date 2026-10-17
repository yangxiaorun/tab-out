# Tab Out macOS Installation and Sync Runbook

This runbook is for an agent installing or upgrading Tab Out on another Mac.
Use version `1.1.1` or newer. Do not treat the displayed extension version as
proof that GitHub sync is working.

## What Gets Synced

- Daily priority history is synced through
  `yangxiaorun/tab-out-todo-private`.
- Open tabs and saved links remain in local Chrome storage.
- Todo history is append-only. Connecting a machine merges its existing local
  history with the remote history instead of replacing either side.
- Each Mac needs its own GitHub authorization.

## Safety Rules

- Keep the code repository in a permanent location. Moving an unpacked Chrome
  extension can change its extension ID and separate it from its old local
  storage.
- Never print a GitHub token, write one to a file, or pass one on a command
  line. Use the macOS Keychain helper or the password field in Sync settings.
- Do not reset or discard a dirty Git worktree. Preserve existing changes
  before updating.
- Do not clone the private todo repository into a permanent working directory.
  Use a temporary directory if command-line inspection is necessary.

## Existing Installation

Use this flow when Tab Out is already loaded from the repository's
`extension/` directory.

1. Inspect the repository before updating:

   ```bash
   cd <TAB_OUT_DIR>
   git status --short --branch
   git remote -v
   ```

   Continue only when local work is understood and preserved.

2. Fast-forward to the latest `main`:

   ```bash
   git fetch --prune origin
   git merge --ff-only origin/main
   ```

3. Install or refresh the native Keychain helper:

   ```bash
   python3 scripts/github-todo-host.py --install
   python3 scripts/github-todo-host.py --check
   ```

   The installer copies the executable helper to:

   ```text
   ~/Library/Application Support/Tab Out/github-todo-host.py
   ```

   It registers the helper with Chrome at:

   ```text
   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tab_out.github_keychain.json
   ```

4. Restart Chrome by entering `chrome://restart` in the address bar. Reloading
   only the extension is not sufficient after installing a native host.

5. Open `chrome://extensions` and confirm:

   - Tab Out is enabled.
   - The displayed version is `1.1.1` or newer.
   - The extension is still loaded from `<TAB_OUT_DIR>/extension`.

6. Open a new tab, select **Sync settings**, then click
   **Use this Mac's GitHub key**.

7. Wait for the status to become **Synced HH:MM**. The status tooltip must name
   `yangxiaorun/tab-out-todo-private`.

## Fresh Installation

1. Clone the repository into a permanent location:

   ```bash
   git clone git@github.com:yangxiaorun/tab-out.git <TAB_OUT_DIR>
   cd <TAB_OUT_DIR>
   ```

2. Open `chrome://extensions`, enable **Developer mode**, and click
   **Load unpacked**.

3. Select the absolute `<TAB_OUT_DIR>/extension` directory. Keep this path
   stable after local todo data is created.

4. Run the helper installation and repository check:

   ```bash
   python3 scripts/github-todo-host.py --install
   python3 scripts/github-todo-host.py --check
   ```

5. Restart Chrome with `chrome://restart`.

6. Open Tab Out, select **Sync settings**, and click
   **Use this Mac's GitHub key**.

7. Complete every check in the Acceptance section below.

## GitHub Authorization

The Keychain helper expects an internet-password entry with:

```text
server: github.com
account: yangxiaorun
```

The credential must be a GitHub personal access token (PAT), not the GitHub
account password. An agent with the `github-account-yangxiaorun` skill must
follow that skill and reuse the existing Keychain credential. Do not create or
duplicate a token unless the user explicitly requests it.

An agent can verify that the Keychain item exists without printing its secret:

```bash
security find-internet-password -a yangxiaorun -s github.com >/dev/null 2>&1
```

The required agent flow is:

1. Run `python3 scripts/github-todo-host.py --install`.
2. Run `python3 scripts/github-todo-host.py --check`.
3. Restart Chrome, then explicitly reload Tab Out in
   `chrome://extensions`. A browser restart alone may retain old unpacked
   extension source.
4. Open Tab Out, expand **Sync settings**, and click
   **Use this Mac's GitHub key**.
5. Wait for **Synced HH:MM** and verify the status names
   `yangxiaorun/tab-out-todo-private`.

Do not stop after installing the helper. **Stored on this device** means that
the PAT has not been saved to this Chrome profile and synchronization is still
disabled.

It verifies the account, creates the dedicated repository when absent, rejects
a public repository, and returns the token only through Chrome's native
messaging pipe. This is the preferred credential-entry path because the PAT is
not exposed in terminal output, chat, screenshots, or command arguments.

If this Mac does not have that Keychain entry, use a GitHub fine-grained token
in **Sync settings**:

- Owner: `yangxiaorun`
- Repository: `tab-out-todo-private`
- Repository access: only `tab-out-todo-private`
- Permission: **Contents: Read and write**

Enter the PAT only in the extension's **Access token** password field. Do not
enter the GitHub account password. Have the user enter the PAT directly unless
they explicitly authorize another secure credential path. Never expose it in
terminal output, logs, chat, commits, screenshots, or the code repository.

Repeat this connection procedure on every Mac. Credentials remain local to
each Chrome profile; they are intentionally not synchronized through GitHub.

## Acceptance

Installation is complete only when all of these are true:

1. `chrome://extensions` shows Tab Out `1.1.1` or newer.
2. The Tab Out page shows **Synced HH:MM**, not **Stored on this device**.
3. The sync status identifies `yangxiaorun/tab-out-todo-private`.
4. The private repository contains `todo/history.json`.
5. Existing local tasks remain visible after connection.
6. An unfinished task created on one connected Mac appears on another
   connected Mac after **Sync now** or the next automatic sync.
7. Completing a task removes it from the active board on both Macs after sync,
   while its `completed` event remains in `todo/history.json`.

The data repository is:

```text
https://github.com/yangxiaorun/tab-out-todo-private
```

The history file is:

```text
https://github.com/yangxiaorun/tab-out-todo-private/blob/main/todo/history.json
```

## Troubleshooting

### `Stored on this device`

The extension code is installed, but GitHub sync is not configured. Open
**Sync settings** and connect this Mac.

### `Native host has exited`

This commonly means an older helper is running from a protected or moved
repository path. Pull version `1.1.1` or newer, rerun:

```bash
python3 scripts/github-todo-host.py --install
```

Then restart all of Chrome with `chrome://restart`.

### `Illegal invocation`

This is the GitHub transport defect in an older worker. Pull the latest `main`
and click **Reload** for Tab Out in `chrome://extensions`. Restarting Chrome
without reloading the unpacked extension may leave the old worker active.

### HTTP `401`, `403`, or `404`

- `401`: the token is invalid or expired.
- `403`: the token lacks repository write access or is rate limited.
- `404`: the private repository is absent or the token cannot access it.

Restore the Keychain credential or enter a fine-grained token limited to the
private data repository.

### One Mac's History Is Missing

Updating the code repository does not connect todo sync by itself. On the
missing Mac, verify **Synced HH:MM**, click **Sync now**, and confirm that the
same private repository is configured. Its local history is uploaded only
after that machine successfully connects.

## Agent Completion Report

Report these facts without exposing task text or credentials:

- installed extension version and extension ID;
- sync status and repository owner/name;
- whether `todo/history.json` exists;
- event count and device count, if inspected;
- test results;
- code commit and remote branch, if the agent changed the repository.
