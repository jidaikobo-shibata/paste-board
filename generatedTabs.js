import { _ } from './i18n.js';
import { runCommand } from './commandOutput.js';

export function generatedItems(text, tabId) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length > 1000)
    throw new Error(_('The command returned more than 1000 items.'));
  return lines.map((line, index) => ({
    id: `${tabId}:generated:${index}`,
    kind: 'text',
    name: '',
    text: line,
  }));
}

// A panel visit owns tab snapshots. Only completed results survive tab switches.
// Results never enter persisted sets.
export class GeneratedTabs {
  constructor(onChange, { execute = runCommand } = {}) {
    this.onChange = onChange;
    this.execute = execute;
    this.record = null;
    this.records = new Map();
  }

  get(tab) {
    const record = this.records.get(tab.id);
    const signature = JSON.stringify([tab.id, tab.command, tab.executionMode]);
    return record?.signature === signature ? record : null;
  }

  sync(tab, { autoRun = true } = {}) {
    if (this.record?.tab.id !== tab.id) this.suspend();
    let record = this.get(tab);
    if (!record) {
      this._discard(tab.id);
      const signature = JSON.stringify([
        tab.id,
        tab.command,
        tab.executionMode,
      ]);
      record = { signature, state: 'idle', items: [], tab: { ...tab } };
      this.records.set(tab.id, record);
    }
    this.record = record;
    if (autoRun && record.state === 'idle') this._start();
    return record;
  }

  refresh(tab) {
    this._discard(tab.id);
    this.sync(tab, { autoRun: false });
    this._start();
  }

  _start() {
    const record = this.record;
    record.state = 'pending';
    record.items = [];
    // Catch launch failures as well as asynchronous failures; never publish a
    // partial result or let a superseded command replace a newer snapshot.
    Promise.resolve()
      .then(() => {
        if (
          this.records.get(record.tab.id) !== record ||
          record.state !== 'pending'
        )
          return;
        record.running = this.execute(record.tab.command, {
          executionMode: record.tab.executionMode,
          trimTrailingNewlines: false,
          allowEmptyOutput: true,
        });
        return record.running.promise;
      })
      .then((text) => {
        if (
          this.records.get(record.tab.id) !== record ||
          record.state !== 'pending'
        )
          return;
        record.items = generatedItems(text, record.tab.id);
        record.state = 'ready';
        record.running = null;
        this._notify();
      })
      .catch((error) => {
        if (
          this.records.get(record.tab.id) !== record ||
          record.state !== 'pending'
        )
          return;
        record.state = 'error';
        record.error = error;
        record.running = null;
        this._notify();
      });
  }

  _notify() {
    try {
      this.onChange?.();
    } catch (error) {
      console.error(error);
    }
  }

  stop() {
    const record = this.record;
    if (!record) return;
    record.state = 'stopped';
    record.running?.cancel();
    record.running = null;
    record.items = [];
  }

  _discard(id) {
    const record = this.records.get(id);
    this.records.delete(id);
    if (this.record === record) this.record = null;
    if (record) {
      record.state = 'stopped';
      record.running?.cancel();
      record.running = null;
      record.items = [];
    }
  }

  suspend() {
    if (this.record?.state === 'pending') this._discard(this.record.tab.id);
    this.record = null;
  }

  clear() {
    for (const id of this.records.keys()) this._discard(id);
    this.record = null;
  }

  destroy() {
    this.onChange = null;
    this.clear();
  }
}
