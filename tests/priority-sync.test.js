const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto').webcrypto;
globalThis.crypto ||= crypto;
const Store = require('../extension/priority-store.js');
const { GitHubSync, CONFIG_KEY, STATUS_KEY } = require('../extension/priority-sync.js');

function storage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in data) result[key] = structuredClone(data[key]);
      }
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of keys) delete data[key]; },
  };
}
const time = value => new Date(`${value}T12:00:00`);
const config = { owner: 'test-owner', repo: 'private-todo', token: 'test-credential', branch: 'main' };
function response(status, value) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(value), text: async () => value };
}
function github(initial) {
  const server = { journal: initial || Store.empty(), sha: initial ? '1' : null,
    writes: [], requests: [], private: true, online: true, injectConflict: null };
  server.fetch = async (url, options) => {
    server.requests.push(url);
    if (!server.online) throw new Error('offline');
    if (url.endsWith('/private-todo')) return response(200, { private: server.private, default_branch: 'main', permissions: { push: true } });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (server.injectConflict) {
        server.journal = Store.merge(server.journal, server.injectConflict);
        server.sha = `${Number(server.sha || 0) + 1}`;
        server.injectConflict = null;
        return response(409, {});
      }
      if (body.sha !== (server.sha || undefined)) return response(409, {});
      server.journal = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      server.sha = `${Number(server.sha || 0) + 1}`;
      server.writes.push(body);
      return response(200, { content: { sha: server.sha } });
    }
    return server.sha ? response(200, {
      encoding: 'base64', sha: server.sha,
      content: Buffer.from(JSON.stringify(server.journal)).toString('base64'),
    }) : response(404, {});
  };
  return server;
}

test('GitHub transport does not rebind an injected fetch implementation', async () => {
  const db = storage();
  const store = new Store.Store(db);
  const fetcher = function () {
    'use strict';
    assert.equal(this, undefined);
    return response(200, { private: true, default_branch: 'main', permissions: { push: true } });
  };
  const sync = new GitHubSync(store, db, fetcher);
  assert.equal((await sync.verify(config)).branch, 'main');
});

function backgroundHarness(db, fetcher = async () => response(401, {})) {
  let listener;
  const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
  const event = { addListener() {} };
  const context = vm.createContext({
    PriorityStore: Store, PrioritySync: { GitHubSync },
    importScripts() {}, setTimeout() { return 1; }, clearTimeout() {},
    Date, Promise, fetch: fetcher,
    chrome: {
      storage: { local: db },
      runtime: { id: 'extension-id', getURL: p => `chrome-extension://extension-id/${p}`,
        sendNativeMessage: async () => { throw new Error('Native host has exited.'); },
        onMessage: { addListener(fn) { listener = fn; } }, onInstalled: event, onStartup: event },
      alarms: { get: async () => ({ name: 'existing' }), create: async () => {}, onAlarm: event },
      tabs: { query: async () => [], onCreated: event, onRemoved: event, onUpdated: event },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    },
  });
  context.PrioritySync = { GitHubSync: class extends GitHubSync {
    constructor(store, storage) { super(store, storage, context.fetch); }
  } };
  vm.runInContext(source, context);
  const sender = {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/index.html',
  };
  const send = message => new Promise(resolve => {
    assert.equal(listener({
      channel: 'priority',
      protocolVersion: 1,
      ...message,
    }, sender, resolve), true);
  });
  const sendVersion = (message, protocolVersion) => new Promise(resolve => {
    let response;
    const keepOpen = listener({
      channel: 'priority',
      protocolVersion,
      ...message,
    }, sender, value => { response = value; });
    resolve({ keepOpen, response });
  });
  return { send, sendVersion };
}

test('carryover keeps the original identity, plan time, and all completion/reopen events', async () => {
  const db = storage();
  const store = new Store.Store(db);
  await store.dispatch({ type: 'add', text: '完成评测 🧪' }, time('2026-10-10'));
  const first = Store.board(db.data.priorityJournal, '2026-10-10').today[0];
  const second = Store.board(db.data.priorityJournal, '2026-10-13').today[0];
  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.inherited, true);
  await store.dispatch({ type: 'update', id: first.id, patch: { completed: true } }, time('2026-10-13'));
  await store.dispatch({ type: 'update', id: first.id, patch: { completed: false } }, time('2026-10-13'));
  await store.dispatch({ type: 'update', id: first.id, patch: { completed: true } }, time('2026-10-13'));
  assert.deepEqual(db.data.priorityJournal.events.map(e => e.type), ['created', 'completed', 'reopened', 'completed']);
  assert.equal(Store.project(db.data.priorityJournal)[0].completedAt, time('2026-10-13').toISOString());
  assert.equal(Store.board(db.data.priorityJournal, '2026-10-13').today.length, 0);
  assert.equal(Store.board(db.data.priorityJournal, '2026-10-13').completedCount, 1);
  assert.equal(Store.board(db.data.priorityJournal, '2026-10-14').today.length, 0);
});

test('deletion stays in history and cannot be resurrected by an offline device', async () => {
  const db = storage();
  const store = new Store.Store(db);
  await store.dispatch({ type: 'add', text: 'private' });
  const original = structuredClone(db.data.priorityJournal);
  const id = Store.project(original)[0].id;
  await store.dispatch({ type: 'delete', id });
  const combined = Store.merge(original, db.data.priorityJournal);
  assert.equal(Store.board(combined).today.length, 0);
  assert.equal(combined.events.length, 2);
  assert.equal(Store.project(combined)[0].text, 'private');
});

test('legacy migration retains timestamps and archived carryover rows without rewriting originals', async () => {
  const legacy = [
    { id: 'old', text: '  previous  ', date: '2026-10-09', createdAt: '2026-10-09T08:00:00Z', carriedToDate: '2026-10-10' },
    { id: 'copy', text: 'previous', date: '2026-10-10', createdAt: '2026-10-10T08:00:00Z', inherited: true, inheritedFrom: '2026-10-09' },
    { id: 'done', text: 'done', date: '2026-10-09', completed: true, completedAt: '2026-10-09T15:00:00Z' },
  ];
  const db = storage({ priorityTasks: legacy });
  const store = new Store.Store(db);
  await store.load();
  await store.load();
  assert.deepEqual(db.data.priorityTasks, legacy);
  assert.equal(db.data.priorityJournal.events.length, 3);
  assert.equal(Store.board(db.data.priorityJournal, '2026-10-13').today[0].id, 'copy');
  assert.equal(Store.project(db.data.priorityJournal).find(t => t.id === 'done').completedAt, legacy[2].completedAt);
  assert.deepEqual(Store.migrate(legacy), Store.migrate(legacy));
});

test('concurrent local edits are serialized, with unique tasks and increasing clocks', async () => {
  const db = storage();
  const store = new Store.Store(db);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.dispatch({ type: 'add', text: `task ${i}` })));
  assert.equal(Store.board(db.data.priorityJournal).today.length, 30);
  assert.deepEqual(db.data.priorityJournal.events.map(e => e.clock), Array.from({ length: 30 }, (_, i) => i + 1));
});

test('merging simultaneous independent fields converges and retains both changes', async () => {
  const a = storage();
  const storeA = new Store.Store(a);
  await storeA.dispatch({ type: 'add', text: 'initial' });
  const b = storage({ priorityJournal: a.data.priorityJournal, priorityDeviceId: 'device-b' });
  const storeB = new Store.Store(b);
  const id = Store.project(a.data.priorityJournal)[0].id;
  await storeA.dispatch({ type: 'update', id, patch: { text: 'edited' } });
  await storeB.dispatch({ type: 'update', id, patch: { completed: true } });
  const ab = Store.merge(a.data.priorityJournal, b.data.priorityJournal);
  const ba = Store.merge(b.data.priorityJournal, a.data.priorityJournal);
  assert.deepEqual(ab, ba);
  assert.equal(Store.project(ab)[0].text, 'edited');
  assert.equal(Store.project(ab)[0].completed, true);
  assert.equal(ab.events.length, 3);
});

test('keyboard and drag reorder work for tasks spanning different days', async () => {
  const db = storage();
  const store = new Store.Store(db);
  await store.dispatch({ type: 'add', text: 'old' }, time('2026-10-10'));
  await store.dispatch({ type: 'add', text: 'today' }, time('2026-10-13'));
  let board = Store.board(db.data.priorityJournal, '2026-10-13').today;
  await store.dispatch({ type: 'move', id: board[1].id, direction: -1 }, time('2026-10-13'));
  board = Store.board(db.data.priorityJournal, '2026-10-13').today;
  assert.deepEqual(board.map(t => t.text), ['today', 'old']);
  await store.dispatch({ type: 'reorder', id: board[1].id, targetId: board[0].id }, time('2026-10-13'));
  assert.deepEqual(Store.board(db.data.priorityJournal, '2026-10-13').today.map(t => t.text), ['old', 'today']);
});

test('offline changes sync on recovery and no credential enters GitHub history', async () => {
  const db = storage({ [CONFIG_KEY]: config });
  const store = new Store.Store(db);
  const server = github();
  const sync = new GitHubSync(store, db, server.fetch);
  await store.dispatch({ type: 'add', text: '中文计划 📆' });
  server.online = false;
  const offline = await sync.run();
  assert.equal(offline.state, 'error');
  assert.match(offline.message, /Chrome reported: offline/);
  assert.equal(db.data.priorityJournal.events.length, 1);
  server.online = true;
  assert.equal((await sync.run()).state, 'synced');
  assert.equal(Store.project(server.journal)[0].text, '中文计划 📆');
  assert.ok(!JSON.stringify(server.journal).includes(config.token));
  assert.ok(!JSON.stringify(await sync.status()).includes(config.token));
  assert.equal(server.writes[0].message, 'Sync todo history');
});

test('SHA conflict retries merge another device instead of overwriting it', async () => {
  const a = storage({ [CONFIG_KEY]: config });
  const b = storage();
  const storeA = new Store.Store(a);
  const storeB = new Store.Store(b);
  await storeA.dispatch({ type: 'add', text: 'device A' });
  await storeB.dispatch({ type: 'add', text: 'device B' });
  const server = github();
  server.injectConflict = b.data.priorityJournal;
  const sync = new GitHubSync(storeA, a, server.fetch);
  assert.equal((await sync.run()).state, 'synced');
  assert.equal(Store.project(server.journal).length, 2);
  assert.deepEqual(server.journal, a.data.priorityJournal);
  const writes = server.writes.length;
  await sync.run();
  assert.equal(server.writes.length, writes);
});

test('two devices download changes and produce the same board', async () => {
  const a = storage({ [CONFIG_KEY]: config });
  const b = storage({ [CONFIG_KEY]: config });
  const storeA = new Store.Store(a);
  const storeB = new Store.Store(b);
  const server = github();
  const syncA = new GitHubSync(storeA, a, server.fetch);
  const syncB = new GitHubSync(storeB, b, server.fetch);
  await storeA.dispatch({ type: 'add', text: 'shared' });
  await syncA.run();
  await syncB.run();
  const id = Store.project(b.data.priorityJournal)[0].id;
  await storeB.dispatch({ type: 'update', id, patch: { completed: true } });
  await syncB.run();
  await syncA.run();
  assert.deepEqual(Store.board(a.data.priorityJournal), Store.board(b.data.priorityJournal));
});

test('public repositories and invalid journals are rejected without overwriting data', async () => {
  const db = storage({ [CONFIG_KEY]: config });
  const store = new Store.Store(db);
  await store.dispatch({ type: 'add', text: 'private' });
  const before = structuredClone(db.data.priorityJournal);
  const server = github();
  const sync = new GitHubSync(store, db, server.fetch);
  server.private = false;
  assert.equal((await sync.run()).state, 'error');
  assert.equal(server.writes.length, 0);
  server.private = true;
  server.journal = { schemaVersion: 999, events: [] };
  server.sha = '1';
  assert.equal((await sync.run()).state, 'error');
  assert.deepEqual(db.data.priorityJournal, before);
  assert.equal(server.writes.length, 0);
});

test('large journals use raw immutable blobs and preserve Unicode', async () => {
  const journal = Store.migrate([{ id: 'large', date: '2026-10-10', text: '长期记录' }]);
  const db = storage({ [CONFIG_KEY]: config });
  const store = new Store.Store(db);
  const calls = [];
  const sync = new GitHubSync(store, db, async (url, options) => {
    calls.push(url);
    if (url.endsWith('/private-todo')) return response(200, { private: true, default_branch: 'main' });
    if (url.includes('/contents/')) return response(200, { encoding: 'none', sha: 'blob-sha' });
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
    return response(200, JSON.stringify(journal));
  });
  assert.equal((await sync.run()).state, 'synced');
  assert.equal(Store.project(db.data.priorityJournal)[0].text, '长期记录');
  assert.ok(calls.some(url => url.endsWith('/git/blobs/blob-sha')));
});

test('a local edit during upload remains pending and is sent by the next sync', async () => {
  const db = storage({ [CONFIG_KEY]: config });
  const store = new Store.Store(db);
  await store.dispatch({ type: 'add', text: 'first' });
  const server = github();
  let injected = false;
  const sync = new GitHubSync(store, db, async (url, options) => {
    if (options.method === 'PUT' && !injected) {
      injected = true;
      await store.dispatch({ type: 'add', text: 'while uploading' });
    }
    return server.fetch(url, options);
  });
  assert.equal((await sync.run()).state, 'pending');
  assert.equal(db.data.priorityJournal.events.length, 2);
  assert.equal(server.journal.events.length, 1);
  assert.equal((await sync.run()).state, 'synced');
  assert.equal(server.journal.events.length, 2);
});

test('disconnect removes the token while retaining local and remote history', async () => {
  const db = storage({ [CONFIG_KEY]: config, [STATUS_KEY]: { state: 'synced' } });
  const store = new Store.Store(db);
  await store.dispatch({ type: 'add', text: 'retain' });
  const sync = new GitHubSync(store, db);
  assert.equal((await sync.disconnect()).configured, false);
  assert.equal(db.data[CONFIG_KEY], undefined);
  assert.equal(db.data.priorityJournal.events.length, 1);
});

test('background stores todos without a sync repository and rejects mixed component versions', async () => {
  const db = storage();
  const { send, sendVersion } = backgroundHarness(db);

  const incompatible = await sendVersion({
    action: 'dispatch',
    operation: { type: 'add', text: 'must not be stored' },
  }, 0);
  assert.equal(incompatible.keepOpen, false);
  assert.equal(incompatible.response.ok, false);
  assert.match(incompatible.response.error, /different versions/i);

  const added = await send({
    action: 'dispatch',
    operation: { type: 'add', text: 'local first' },
  });
  assert.equal(added.ok, true);
  assert.equal(added.data, true);
  const state = await send({ action: 'dispatch', operation: { type: 'state' } });
  assert.equal(state.data.today[0].text, 'local first');
  assert.equal(db.data[CONFIG_KEY], undefined);
  assert.equal(db.data[STATUS_KEY], undefined);
});

test('background messages serialize multiple tabs and allow local edits while network is blocked', async () => {
  const db = storage({ [CONFIG_KEY]: config });
  let releaseNetwork;
  const networkGate = new Promise(resolve => { releaseNetwork = resolve; });
  const { send } = backgroundHarness(db, async () => {
    await networkGate;
    return response(401, {});
  });
  const keychain = await send({ action: 'sync-keychain' });
  assert.equal(keychain.ok, false);
  assert.match(keychain.error, /Native host has exited/);
  const syncing = send({ action: 'sync-now' });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    send({ action: 'dispatch', operation: { type: 'add', text: `tab ${i}` } })));
  assert.ok(results.every(r => r.ok));
  assert.equal(db.data.priorityJournal.events.length, 10);
  releaseNetwork();
  assert.equal((await syncing).data.state, 'error');
});
