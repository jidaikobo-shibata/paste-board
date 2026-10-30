import { runCommand } from './commandOutput.js';
import { _ } from './i18n.js';

const signature = (item) =>
  JSON.stringify([
    item.command,
    item.executionMode || 'direct',
    item.trimTrailingNewlines !== false,
  ]);

// A cache belongs to one visible tab visit, never to persisted paste-set data.
export class CommandPreviews {
  constructor(onChange, { execute = runCommand, concurrency = 2 } = {}) {
    this.onChange = onChange;
    this.execute = execute;
    this.concurrency = concurrency;
    this.records = new Map();
    this.queue = [];
    this.active = new Set();
  }

  sync(items) {
    const desired = new Map(
      items
        .filter(
          (item) => item.kind === 'command' && item.previewOnOpen === true,
        )
        .map((item) => [item.id, item]),
    );
    for (const [id, record] of this.records) {
      if (!desired.has(id) || record.signature !== signature(desired.get(id))) {
        this.records.delete(id);
        this._cancel(record);
      }
    }
    for (const [id, item] of desired) {
      if (this.records.has(id)) continue;
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // A preview may fail without ever being selected for paste.
      promise.catch(() => {});
      const record = {
        id,
        item: { ...item },
        signature: signature(item),
        state: 'pending',
        promise,
        resolve,
        reject,
      };
      this.records.set(id, record);
      this.queue.push(record);
    }
    this._pump();
  }

  get(item) {
    const record = this.records.get(item.id);
    return record?.signature === signature(item) ? record : null;
  }

  _cancel(record) {
    record.state = 'cancelled';
    record.reject(new Error(_('Command execution was cancelled.')));
    record.running?.cancel();
  }

  _pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const record = this.queue.shift();
      if (this.records.get(record.id) !== record || record.state !== 'pending')
        continue;
      this.active.add(record);
      // A separate microtask also catches synchronous launch failures in test adapters.
      Promise.resolve()
        .then(() => {
          if (record.state === 'cancelled')
            throw new Error(_('Command execution was cancelled.'));
          record.running = this.execute(record.item.command, {
            executionMode: record.item.executionMode,
            trimTrailingNewlines: record.item.trimTrailingNewlines,
          });
          return record.running.promise;
        })
        .then(
          (text) => {
            if (this.records.get(record.id) !== record) return;
            record.state = 'ready';
            record.text = text;
            record.resolve(text);
            this._notify(record.id);
          },
          (error) => {
            if (this.records.get(record.id) !== record) return;
            record.state = 'error';
            record.reject(error);
            this._notify(record.id);
          },
        )
        .finally(() => {
          this.active.delete(record);
          record.running = null;
          this._pump();
        });
    }
  }

  _notify(id) {
    try {
      this.onChange?.(id);
    } catch (error) {
      console.error(error);
    }
  }

  clear() {
    const records = [...this.records.values()];
    this.records.clear();
    this.queue = [];
    for (const record of records) this._cancel(record);
  }

  destroy() {
    this.onChange = null;
    this.clear();
  }
}

export function previewSummary(text) {
  const lines = text.split(/\r?\n/, 3);
  const summary = lines
    .slice(0, 2)
    .map((line) => (line.length > 120 ? line.slice(0, 120) + '…' : line))
    .join('\n');
  if (!summary.trim()) return _('Whitespace output');
  return summary + (lines.length > 2 ? '…' : '');
}
