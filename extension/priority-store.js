/* Todo history is an append-only event set. Only the background worker writes
 * local state, so concurrent new-tab pages cannot overwrite each other. */
(function (root) {
  'use strict';
  const KEY = 'priorityJournal';
  const LEGACY_KEY = 'priorityTasks';
  const SCHEMA = 1;

  function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function empty() { return { schemaVersion: SCHEMA, events: [] }; }

  function validate(journal) {
    if (!journal || journal.schemaVersion !== SCHEMA || !Array.isArray(journal.events)) {
      throw new Error('Unsupported todo history format. No data was overwritten.');
    }
    for (const event of journal.events) {
      if (!event || typeof event.id !== 'string' || typeof event.taskId !== 'string' ||
          typeof event.deviceId !== 'string' || !Number.isSafeInteger(event.clock) ||
          !Number.isFinite(Date.parse(event.at)) || !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
          !['created', 'imported', 'edited', 'completed', 'reopened', 'deleted', 'reordered'].includes(event.type) ||
          !event.data || typeof event.data !== 'object') {
        throw new Error('Invalid todo history. No data was overwritten.');
      }
      if (['created', 'imported'].includes(event.type) &&
          (typeof event.data.text !== 'string' || !event.data.text.trim() ||
           !/^\d{4}-\d{2}-\d{2}$/.test(event.data.date))) {
        throw new Error('Invalid todo creation record. No data was overwritten.');
      }
      if (event.type === 'edited' && (typeof event.data.text !== 'string' || !event.data.text.trim())) {
        throw new Error('Invalid todo title change. No data was overwritten.');
      }
      if (event.type === 'reordered' && !Number.isFinite(event.data.order)) {
        throw new Error('Invalid todo order. No data was overwritten.');
      }
    }
    return journal;
  }

  function compare(a, b) {
    return a.clock - b.clock || a.deviceId.localeCompare(b.deviceId) || a.id.localeCompare(b.id);
  }

  function merge(...journals) {
    const events = new Map();
    for (const journal of journals) {
      for (const event of validate(journal).events) {
        const previous = events.get(event.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
          throw new Error('Conflicting history event IDs. No data was overwritten.');
        }
        events.set(event.id, event);
      }
    }
    return { schemaVersion: SCHEMA, events: [...events.values()].sort(compare) };
  }

  function project(journal) {
    const tasks = new Map();
    for (const event of [...validate(journal).events].sort(compare)) {
      let task = tasks.get(event.taskId);
      if (event.type === 'created' || event.type === 'imported') {
        if (task) continue;
        task = {
          ...event.data,
          id: event.taskId,
          completed: Boolean(event.data.completed),
          deleted: Boolean(event.data.deleted),
          order: Number.isFinite(event.data.order) ? event.data.order : 0,
        };
        tasks.set(event.taskId, task);
      } else if (task) {
        if (event.type === 'edited') task.text = event.data.text;
        if (event.type === 'completed') {
          task.completed = true;
          task.completedAt = event.at;
          task.completedDate = event.date;
        }
        if (event.type === 'reopened') {
          task.completed = false;
          task.completedAt = null;
          task.completedDate = null;
        }
        if (event.type === 'deleted') {
          task.deleted = true;
          task.deletedAt = event.at;
        }
        if (event.type === 'reordered') {
          task.order = event.data.order;
          task.orderDate = event.date;
        }
        task.updatedAt = event.at;
      }
    }
    return [...tasks.values()];
  }

  function board(journal, today = dateKey()) {
    const all = project(journal);
    const visible = all.filter(task => !task.deleted && !task.carriedToDate &&
      task.date <= today && !task.completed);
    visible.sort((a, b) => {
      const aDate = a.orderDate || a.date;
      const bDate = b.orderDate || b.date;
      return aDate.localeCompare(bDate) || a.order - b.order ||
        (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id);
    });
    const tasks = visible.map(task => ({
      ...task,
      inherited: task.date < today || Boolean(task.inherited),
    }));
    const completedCount = all.filter(task =>
      !task.deleted && task.completed && task.completedDate === today
    ).length;
    return {
      all,
      today: tasks,
      completedCount,
      inheritedCount: tasks.filter(task => task.inherited).length,
    };
  }

  // Stable import IDs prevent the same old local item from importing twice.
  // Original carryover rows remain archived; existing copies keep their IDs.
  function migrate(legacy) {
    const journal = empty();
    for (const task of Array.isArray(legacy) ? legacy : []) {
      if (!task?.id || typeof task.text !== 'string' || !task.text.trim() || !task.date) continue;
      const data = {
        ...task,
        text: task.text.trim(),
        createdAt: task.createdAt || null,
        completedAt: task.completedAt || null,
        completedDate: task.completedAt ? task.completedAt.slice(0, 10) :
          (task.completed ? task.date : null),
        timestampSource: 'legacy',
        // Older carryover copies did not retain an explicit parent task ID.
        originalPlannedDate: task.inheritedFrom || task.date,
      };
      journal.events.push({
        id: `legacy:${task.id}`,
        taskId: task.id,
        deviceId: 'legacy',
        clock: 0,
        type: 'imported',
        at: task.createdAt && Number.isFinite(Date.parse(task.createdAt)) ? task.createdAt : `${task.date}T12:00:00.000Z`,
        date: task.date,
        utcOffsetMinutes: null,
        data,
      });
    }
    return merge(journal);
  }

  class Store {
    constructor(storage) {
      this.storage = storage;
      this.queue = Promise.resolve();
    }

    exclusive(operation) {
      const result = this.queue.then(operation);
      this.queue = result.catch(() => {});
      return result;
    }

    load() { return this.exclusive(() => this.loadUnlocked()); }

    async loadUnlocked() {
      const stored = await this.storage.get([KEY, LEGACY_KEY, 'priorityDeviceId']);
      let deviceId = stored.priorityDeviceId;
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        await this.storage.set({ priorityDeviceId: deviceId });
      }
      let journal = stored[KEY];
      if (!journal) {
        journal = migrate(stored[LEGACY_KEY]);
        await this.storage.set({ [KEY]: journal });
      }
      return { journal: validate(journal), deviceId };
    }

    mergeRemote(remote) { return this.exclusive(() => this.mergeUnlocked(remote)); }

    async mergeUnlocked(remote) {
      const { journal } = await this.loadUnlocked();
      const combined = merge(journal, remote);
      if (JSON.stringify(journal) !== JSON.stringify(combined)) {
        await this.storage.set({ [KEY]: combined });
      }
      return combined;
    }

    dispatch(action, now = new Date()) {
      return this.exclusive(() => this.dispatchUnlocked(action, now));
    }

    async dispatchUnlocked(action, now) {
      let { journal, deviceId } = await this.loadUnlocked();
      const today = dateKey(now);
      if (action.type === 'state') return board(journal, today);
      const visible = board(journal, today).today;
      const task = project(journal).find(item => item.id === action.id);
      let clock = journal.events.reduce((max, event) => Math.max(max, event.clock), 0);
      const append = (type, taskId, data) => {
        journal.events.push({
          id: crypto.randomUUID(), taskId, type, data, deviceId, clock: ++clock,
          at: now.toISOString(), date: today, utcOffsetMinutes: -now.getTimezoneOffset(),
        });
      };
      if (action.type === 'add') {
        const text = String(action.text || '').trim().slice(0, 160);
        if (!text) return false;
        append('created', crypto.randomUUID(), {
          text, date: today, originalPlannedDate: today, createdAt: now.toISOString(),
          completed: false, completedAt: null, completedDate: null,
          order: Math.max(-1, ...visible.map(item => item.order)) + 1,
        });
      } else if (action.type === 'update' && task) {
        if (typeof action.patch?.text === 'string') {
          const text = action.patch.text.trim().slice(0, 160);
          if (text && text !== task.text) append('edited', task.id, { text });
        }
        if (typeof action.patch?.completed === 'boolean' && action.patch.completed !== task.completed) {
          append(action.patch.completed ? 'completed' : 'reopened', task.id, {});
        }
      } else if (action.type === 'delete' && task) {
        append('deleted', task.id, {});
      } else if ((action.type === 'move' || action.type === 'reorder') && task) {
        const sourceIndex = visible.findIndex(item => item.id === task.id);
        if (sourceIndex < 0) return;
        const targetIndex = action.type === 'move' ? sourceIndex + action.direction :
          visible.findIndex(item => item.id === action.targetId);
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= visible.length || targetIndex === sourceIndex) return;
        if (action.type === 'move') {
          [visible[sourceIndex], visible[targetIndex]] = [visible[targetIndex], visible[sourceIndex]];
        } else {
          visible.splice(sourceIndex, 1);
          visible.splice(visible.findIndex(item => item.id === action.targetId), 0, task);
        }
        visible.forEach((item, order) => append('reordered', item.id, { order }));
      } else {
        return;
      }
      await this.storage.set({ [KEY]: journal });
      return true;
    }
  }

  root.PriorityStore = { KEY, empty, validate, merge, project, board, migrate, dateKey, Store };
  if (typeof module !== 'undefined') module.exports = root.PriorityStore;
})(globalThis);
