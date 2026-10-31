import GLib from 'gi://GLib';
import { CommandPreviews, previewSummary } from '../commandPreviews.js';
import { PasteSets } from '../pasteSets.js';
let checks = 0;
const equal = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  checks++;
};
const tick = () =>
  new Promise((resolve) =>
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
async function main() {
  const calls = [],
    changed = [];
  const execute = (command, options) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const run = {
      command,
      options,
      promise,
      resolve,
      reject,
      cancelled: false,
      cancel() {
        this.cancelled = true;
        reject(Error('cancelled'));
      },
    };
    calls.push(run);
    return run;
  };
  const previews = new CommandPreviews((id) => changed.push(id), { execute });
  const item = (id) => ({
    id,
    kind: 'command',
    command: 'printf ' + id,
    previewOnOpen: true,
    executionMode: 'direct',
    trimTrailingNewlines: true,
  });
  const items = ['a', 'b', 'c'].map(item);
  previews.sync([{ ...items[0], previewOnOpen: false }]);
  await tick();
  equal(calls.length, 0);
  previews.sync(items);
  await tick();
  equal(calls.length, 2);
  previews.sync([...items].reverse());
  await tick();
  equal(calls.length, 2);
  calls[0].resolve('stable random value\n');
  await tick();
  equal(calls.length, 3);
  equal(previews.get(items[0]).state, 'ready');
  equal(await previews.get(items[0]).promise, 'stable random value\n');
  previews.sync(items.map((x) => ({ ...x, name: 'renamed' })));
  await tick();
  equal(calls.length, 3);
  equal(await previews.get(items[0]).promise, 'stable random value\n');
  calls[1].resolve('second');
  calls[2].reject(Error('failed'));
  await tick();
  equal(previews.get(items[2]).state, 'error');
  previews.sync(items);
  await tick();
  equal(calls.length, 3);
  const modified = { ...items[0], command: 'printf changed' };
  previews.sync([modified]);
  await tick();
  equal(calls.length, 4);
  equal(previews.get(items[0]), null);
  const waiting = previews.get(modified).promise.catch(() => 'cancelled');
  previews.clear();
  equal(await waiting, 'cancelled');
  await tick();
  equal(calls[3].cancelled, true);
  equal(previews.records.size, 0);
  equal(previews.active.size, 0);
  previews.sync([items[0]]);
  await tick();
  equal(calls.length, 5);
  previews.destroy();
  await tick();
  equal(calls[4].cancelled, true);
  equal(previews.records.size, 0);
  // Closing before the launch microtask must never run queued commands.
  const before = calls.length;
  const early = new CommandPreviews(() => {}, { execute });
  early.sync(items);
  early.clear();
  await tick();
  equal(calls.length, before);
  equal(previewSummary('one\ntwo\nthree'), 'one\ntwo…');
  equal(previewSummary(' \n\t'), 'Whitespace output');
  equal(previewSummary('x'.repeat(130)), 'x'.repeat(120) + '…');
  equal(previewSummary('\n\nActual text'), '\n…');
  equal(previewSummary('\r\n\r\nActual text'), '\n…');
  equal(previewSummary(' \n\t\nActual text'), ' \n\t…');
  // Selected queued items move ahead without restarting either active command.
  const priority = new CommandPreviews(() => {}, { execute });
  const six = Array.from({ length: 6 }, (_, i) => item('priority-' + i));
  const offset = calls.length;
  priority.sync(six);
  await tick();
  const selected = priority.request(six[5], { timeoutMs: 1000 });
  equal(calls.length, offset + 2);
  calls[offset].resolve('first');
  await tick();
  equal(calls[offset + 2].command, six[5].command);
  calls[offset + 2].resolve('selected output');
  equal(await selected.promise, 'selected output');
  equal(priority.get(six[5]).state, 'ready');
  equal(await priority.request(six[5]).promise, 'selected output');
  priority.destroy();
  await tick();
  // Waiting has a deadline even if no execution slot becomes available.
  const deadline = new CommandPreviews(() => {}, { execute, concurrency: 1 });
  const start = calls.length;
  deadline.sync(six.slice(0, 2));
  await tick();
  const waitingDeadline = deadline.request(six[1], { timeoutMs: 15 });
  let timedOut = false;
  try {
    await waitingDeadline.promise;
  } catch (error) {
    timedOut = error.message.includes('timed out');
  }
  equal(timedOut, true);
  equal(deadline.get(six[1]).state, 'error');
  calls[start].resolve('released');
  await tick();
  equal(calls.length, start + 1);
  deadline.sync(six.slice(0, 2));
  await tick();
  equal(calls.length, start + 1);
  deadline.destroy();
  await tick();
  // A selected running command is cancelled when its wait expires too.
  const runningDeadline = new CommandPreviews(() => {}, { execute });
  const activeIndex = calls.length;
  runningDeadline.sync(six.slice(0, 1));
  await tick();
  try {
    await runningDeadline.request(six[0], { timeoutMs: 15 }).promise;
  } catch {}
  await tick();
  equal(calls[activeIndex].cancelled, true);
  equal(runningDeadline.get(six[0]).state, 'error');
  equal(runningDeadline.get(six[0]).text, undefined);
  runningDeadline.destroy();
  // A late success from a non-cooperative adapter cannot revive an expired result.
  let lateResolve;
  const late = new CommandPreviews(() => {}, {
    execute: () => ({
      promise: new Promise((resolve) => {
        lateResolve = resolve;
      }),
      cancel() {},
    }),
  });
  late.sync(six.slice(0, 1));
  await tick();
  try {
    await late.request(six[0], { timeoutMs: 10 }).promise;
  } catch {}
  lateResolve('too late');
  await tick();
  equal(late.get(six[0]).state, 'error');
  equal(late.get(six[0]).text, undefined);
  late.destroy();
  // Leaving the tab rejects a selected wait and releases its deadline timer.
  const leaving = new CommandPreviews(() => {}, { execute });
  leaving.sync(six.slice(0, 1));
  await tick();
  const selection = leaving.request(six[0], { timeoutMs: 1000 });
  const cancelledSelection = selection.promise.catch(() => 'cancelled');
  selection.cancel();
  leaving.clear();
  equal(await cancelledSelection, 'cancelled');
  await tick();
  equal(leaving.active.size, 0);
  // Defaults and persistence must not accidentally opt existing commands in.
  const directory = GLib.dir_make_tmp('paste-board-previews.XXXXXX');
  const sets = new PasteSets(directory);
  try {
    const id = sets.create('Preview samples');
    sets.put(id, { name: 'Existing', kind: 'command', command: 'printf test' });
    equal(sets.data.sets[0].items[0].previewOnOpen, false);
    const original = sets.data.sets[0].items[0];
    sets.put(id, { ...original, previewOnOpen: true });
    await sets.flush();
    equal(new PasteSets(directory).data.sets[0].items[0].previewOnOpen, true);
    const target = sets.create('Copy');
    sets.put(target, { ...sets.data.sets[0].items[0], id: undefined });
    equal(sets.data.sets[1].items[0].previewOnOpen, true);
    const snapshot = JSON.stringify(sets.data);
    let refused = false;
    try {
      sets.put(id, { ...original, previewOnOpen: 'true' });
    } catch {
      refused = true;
    }
    equal(refused, true);
    equal(JSON.stringify(sets.data), snapshot);
    sets.put(id, { id: original.id, name: 'Text now', text: 'literal' });
    equal(sets.data.sets[0].items[0].previewOnOpen, undefined);
    await sets.close();
  } finally {
    await PasteSets.waitForWrites();
    GLib.unlink(sets.path);
    GLib.rmdir(directory);
  }
  print(`Command previews: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((e) => {
    failure = e;
  })
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
