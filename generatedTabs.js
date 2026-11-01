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

// One visible tab visit owns one snapshot. Results never enter persisted sets.
export class GeneratedTabs {
  constructor(onChange, { execute = runCommand } = {}) {
    this.onChange = onChange;
    this.execute = execute;
    this.record = null;
  }

  sync(tab, { autoRun = true } = {}) {
    const signature = JSON.stringify([tab.id, tab.command, tab.executionMode]);
    if (this.record?.signature !== signature) {
      this.clear();
      this.record = { signature, state: 'idle', items: [], tab: { ...tab } };
    }
    if (autoRun && this.record.state === 'idle') this._start();
    return this.record;
  }

  refresh(tab) {
    this.clear();
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
        if (this.record !== record || record.state !== 'pending') return;
        record.running = this.execute(record.tab.command, {
          executionMode: record.tab.executionMode,
          trimTrailingNewlines: false,
          allowEmptyOutput: true,
        });
        return record.running.promise;
      })
      .then((text) => {
        if (this.record !== record || record.state !== 'pending') return;
        record.items = generatedItems(text, record.tab.id);
        record.state = 'ready';
        record.running = null;
        this._notify();
      })
      .catch((error) => {
        if (this.record !== record || record.state !== 'pending') return;
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

  clear() {
    this.stop();
    this.record = null;
  }

  destroy() {
    this.onChange = null;
    this.clear();
  }
}
