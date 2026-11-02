import { _, format } from './i18n.js';
import { runCommand } from './commandOutput.js';

export function generatedItems(text, tabId, limit = 1000) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length > limit) {
    const error = new Error(
      format(_('The command returned more than %d items.'), limit),
    );
    error.code = 'item-limit';
    throw error;
  }
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
  constructor(
    onChange,
    { execute = runCommand, getItemLimit = () => 1000 } = {},
  ) {
    this._getItemLimit = getItemLimit;
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

  _start(record = this.record) {
    record.state = 'pending';
    record.items = [];
    // Catch launch failures as well as asynchronous failures; never publish a
    // partial result or let a superseded command replace a newer snapshot.
    return (record.completion = Promise.resolve()
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
        record.output = text;
        record.items = generatedItems(
          text,
          record.tab.id,
          this._getItemLimit(),
        );
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
      }));
  }

  refreshItemLimit() {
    // Revalidate cached output without running a command merely because a
    // preference changed. Pending runs read the current limit on completion.
    for (const record of this.records.values()) {
      if (
        typeof record.output !== 'string' ||
        !(
          record.state === 'ready' ||
          (record.state === 'error' && record.error?.code === 'item-limit')
        )
      )
        continue;
      try {
        record.items = generatedItems(
          record.output,
          record.tab.id,
          this._getItemLimit(),
        );
        record.state = 'ready';
        record.error = null;
      } catch (error) {
        record.items = [];
        record.state = 'error';
        record.error = error;
      }
    }
    this._notify();
  }

  // One sequential batch per nonempty cross-tab search. Query edits only filter.
  search(tabs, enabled) {
    if (!enabled) {
      this.endSearch();
      return;
    }
    if (this.searchSession) return;
    const session = { cancelled: false, pending: null };
    this.searchSession = session;
    const run = async () => {
      for (const tab of tabs) {
        if (session.cancelled) return;
        if (tab.kind !== 'generated' || tab.runOnSearch !== true) continue;
        // Reuse an already-running visit rather than execute it twice.
        let record = this.get(tab);
        if (record?.state !== 'pending') {
          this._discard(tab.id);
          record = {
            signature: JSON.stringify([tab.id, tab.command, tab.executionMode]),
            state: 'idle',
            items: [],
            tab: { ...tab },
          };
          this.records.set(tab.id, record);
        }
        session.pending = record;
        if (record.state === 'pending') await record.completion;
        else {
          const completion = this._start(record);
          this._notify();
          await completion;
        }
        session.pending = null;
      }
    };
    run().catch((error) => console.error(error));
  }

  endSearch() {
    const session = this.searchSession;
    this.searchSession = null;
    if (!session) return;
    session.cancelled = true;
    if (session.pending?.state === 'pending')
      this._discard(session.pending.tab.id);
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
    delete record.output;
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
      delete record.output;
    }
  }

  suspend() {
    if (this.record?.state === 'pending') this._discard(this.record.tab.id);
    this.record = null;
  }

  clear() {
    this.endSearch();
    for (const id of this.records.keys()) this._discard(id);
    this.record = null;
  }

  destroy() {
    this.onChange = null;
    this.clear();
  }
}
