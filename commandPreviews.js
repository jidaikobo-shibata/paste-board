import GLib from 'gi://GLib';
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

  request(item, { timeoutMs = 6000 } = {}) {
    const record = this.get(item);
    if (!record) return null;
    if (record.state !== 'pending')
      return { promise: record.promise, cancel() {} };
    const index = this.queue.indexOf(record);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.queue.unshift(record);
    }
    this._pump();
    let cancel;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, text) => {
        if (settled) return;
        settled = true;
        if (timer) GLib.Source.remove(timer);
        timer = null;
        if (error) reject(error);
        else resolve(text);
      };
      cancel = () => finish(new Error(_('Command execution was cancelled.')));
      record.promise.then(
        (text) => finish(null, text),
        (error) => finish(error),
      );
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timer = null;
        const error = new Error(_('Waiting for the preview timed out.'));
        if (record.state === 'pending') {
          record.state = 'error';
          record.reject(error);
          record.running?.cancel();
          this._notify(record.id);
        }
        finish(error);
        return GLib.SOURCE_REMOVE;
      });
    });
    return { promise, cancel: () => cancel() };
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
          if (record.state !== 'pending')
            throw new Error(_('Command execution was cancelled.'));
          record.running = this.execute(record.item.command, {
            executionMode: record.item.executionMode,
            trimTrailingNewlines: record.item.trimTrailingNewlines,
          });
          return record.running.promise;
        })
        .then(
          (text) => {
            if (
              this.records.get(record.id) !== record ||
              record.state !== 'pending'
            )
              return;
            record.state = 'ready';
            record.text = text;
            record.resolve(text);
            this._notify(record.id);
          },
          (error) => {
            if (
              this.records.get(record.id) !== record ||
              record.state !== 'pending'
            )
              return;
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
  if (!text.trim()) return _('Whitespace output');
  return summary + (lines.length > 2 ? '…' : '');
}
