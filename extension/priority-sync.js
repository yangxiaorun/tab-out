/* GitHub transport. Credentials stay in local extension storage and never
 * appear in the history document or commits. */
(function (root) {
  'use strict';
  const CONFIG_KEY = 'prioritySyncConfig';
  const STATUS_KEY = 'prioritySyncStatus';
  const PATH = 'todo/history.json';

  class GitHubSync {
    constructor(store, storage, fetcher = fetch) {
      this.store = store;
      this.storage = storage;
      this.fetcher = fetcher.bind(globalThis);
    }

    async config() {
      const stored = await this.storage.get(CONFIG_KEY);
      return stored[CONFIG_KEY] || null;
    }

    async request(config, path, options = {}, raw = false) {
      let response;
      try {
        response = await this.fetcher(`https://api.github.com${path}`, {
          ...options,
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          cache: 'no-store',
          redirect: 'error',
        });
      } catch (error) {
        const detail = error?.message ? ` Chrome reported: ${error.message}` : '';
        throw new Error(`GitHub is unreachable. Your changes are saved locally and will retry.${detail}`);
      }
      if (!response.ok) {
        const error = new Error(
          response.status === 401 ? 'GitHub token expired or invalid. Update it in Sync settings.' :
          response.status === 403 ? 'GitHub access denied or rate limited. Check repository permissions.' :
          response.status === 404 ? 'Private repository not found, or the token cannot access it.' :
          `GitHub sync failed (HTTP ${response.status}). Your changes are saved locally.`
        );
        error.status = response.status;
        throw error;
      }
      return raw ? response.text() : response.json();
    }

    repoPath(config) {
      return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
    }

    async verify(config) {
      const repo = await this.request(config, this.repoPath(config));
      if (repo.private !== true) throw new Error('Sync requires a private GitHub repository.');
      if (!repo.default_branch) throw new Error('Initialize the private repository with a README first.');
      if (repo.permissions?.push === false) throw new Error('This token does not have write access to the repository.');
      return { ...config, branch: repo.default_branch };
    }

    async configure(input) {
      const current = await this.config();
      const config = {
        owner: String(input.owner || '').trim(),
        repo: String(input.repo || '').trim(),
        token: String(input.token || current?.token || '').trim(),
      };
      if (!/^[a-zA-Z0-9-]+$/.test(config.owner) || !/^[a-zA-Z0-9_.-]+$/.test(config.repo) || !config.token) {
        throw new Error('Enter a repository owner, repository name, and GitHub token.');
      }
      if (current && (config.owner !== current.owner || config.repo !== current.repo)) {
        throw new Error('Disconnect before changing the sync repository.');
      }
      const verified = await this.verify(config);
      await this.storage.set({ [CONFIG_KEY]: verified });
      await this.storage.set({ [STATUS_KEY]: { state: 'pending', message: 'Connecting private repository…' } });
      return this.run();
    }

    async status() {
      const stored = await this.storage.get([CONFIG_KEY, STATUS_KEY]);
      const config = stored[CONFIG_KEY];
      const status = config ? (stored[STATUS_KEY] || { state: 'pending', message: 'Waiting to sync' }) :
        { state: 'disabled', message: 'Stored on this device' };
      // Never send the credential back to a dashboard page.
      return {
        ...status,
        configured: Boolean(config),
        owner: config?.owner || '',
        repo: config?.repo || '',
        branch: config?.branch || '',
      };
    }

    async disconnect() {
      await this.storage.remove([CONFIG_KEY, STATUS_KEY]);
      return this.status();
    }

    async markPending() {
      if (!await this.config()) return;
      const stored = await this.storage.get(STATUS_KEY);
      await this.storage.set({
        [STATUS_KEY]: { ...stored[STATUS_KEY], state: 'pending', message: 'Changes saved locally · waiting to sync' },
      });
    }

    encode(journal) {
      const bytes = new TextEncoder().encode(JSON.stringify(journal, null, 2) + '\n');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return btoa(binary);
    }

    decode(content) {
      const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), char => char.charCodeAt(0));
      return PriorityStore.validate(JSON.parse(new TextDecoder().decode(bytes)));
    }

    async run() {
      let config = await this.config();
      if (!config) return this.status();
      const stored = await this.storage.get(STATUS_KEY);
      const previous = stored[STATUS_KEY] || {};
      await this.storage.set({ [STATUS_KEY]: { ...previous, state: 'syncing', message: 'Syncing with private GitHub repository…' } });
      try {
        // Recheck privacy before every sync, including repositories later made public.
        config = await this.verify(config);
        const endpoint = `${this.repoPath(config)}/contents/${PATH}`;
        for (let attempt = 0; attempt < 4; attempt++) {
          let remote = PriorityStore.empty();
          let sha;
          try {
            const file = await this.request(config, `${endpoint}?ref=${encodeURIComponent(config.branch)}`);
            if (file.encoding === 'base64' && typeof file.content === 'string') {
              remote = this.decode(file.content);
            } else if (file.encoding === 'none' && file.sha) {
              // GitHub omits inline content above 1 MB. Fetch the immutable blob
              // identified by this SHA so large, long-term journals still work.
              const raw = await this.request(config, `${this.repoPath(config)}/git/blobs/${file.sha}`, {}, true);
              remote = PriorityStore.validate(JSON.parse(raw));
            } else {
              throw new Error('Unsupported todo history file. No data was overwritten.');
            }
            sha = file.sha;
          } catch (error) {
            if (error.status !== 404) throw error;
          }
          const journal = await this.store.mergeRemote(remote);
          if (!sha || JSON.stringify(journal) !== JSON.stringify(PriorityStore.merge(remote))) {
            const body = {
              message: 'Sync todo history',
              content: this.encode(journal),
              branch: config.branch,
            };
            if (sha) body.sha = sha;
            try {
              await this.request(config, endpoint, { method: 'PUT', body: JSON.stringify(body) });
            } catch (error) {
              if (error.status === 409 || error.status === 422) continue;
              throw error;
            }
          }
          const at = new Date().toISOString();
          const latest = (await this.store.load()).journal;
          const pending = JSON.stringify(PriorityStore.merge(latest)) !== JSON.stringify(journal);
          await this.storage.set({
            [STATUS_KEY]: {
              state: pending ? 'pending' : 'synced',
              message: pending ? 'New changes saved locally · waiting to sync' : 'Synced with private GitHub repository',
              lastSyncedAt: at, eventCount: journal.events.length,
            },
          });
          return this.status();
        }
        throw new Error('Another device is updating the history. Your changes are saved locally and will retry.');
      } catch (error) {
        await this.storage.set({
          [STATUS_KEY]: { ...previous, state: 'error', message: error.message },
        });
        return this.status();
      }
    }
  }

  root.PrioritySync = { GitHubSync, CONFIG_KEY, STATUS_KEY, PATH };
  if (typeof module !== 'undefined') module.exports = root.PrioritySync;
})(globalThis);
