import GLib from 'gi://GLib';
import { ClipboardDebug } from '../clipboardDebug.js';
let checks = 0;
function equal(actual, expected) {
  checks++;
  if (actual !== expected) throw Error(`${actual} != ${expected}`);
}
function wait(ms) {
  return new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
}
function fixture(mode = 'empty') {
  let notifications = 0;
  let calls = 0;
  let active = true;
  const logs = [];
  const selection = {
    get_mimetypes: () => ['text/plain', 'UTF8_STRING', 'image/png'],
    transfer_finish() {
      if (mode === 'error') throw Error('private content');
    },
    transfer_async(type, mime, limit, output, cancellable, callback) {
      calls++;
      equal(limit, 1);
      equal(mime === 'image/png', false);
      if (mode === 'stall') return;
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (
          !cancellable.is_cancelled() &&
          (mode === 'nonempty' || (mode === 'mixed' && mime === 'UTF8_STRING'))
        )
          output.write_all(new Uint8Array([65]), null);
        callback(selection, {});
        return GLib.SOURCE_REMOVE;
      });
    },
  };
  const monitor = new ClipboardDebug(
    selection,
    1,
    () => active,
    () => notifications++,
    {
      delays: [2, 4, 6],
      confirmMs: 2,
      timeoutMs: 3,
      log: (line) => logs.push(line),
    },
  );
  return {
    monitor,
    logs,
    selection,
    get notifications() {
      return notifications;
    },
    get calls() {
      return calls;
    },
    stop() {
      active = false;
      monitor.cancel();
    },
  };
}
async function main() {
  const empty = fixture();
  empty.monitor.observe();
  await wait(60);
  equal(empty.notifications, 1);
  equal(empty.calls, 4);
  equal(
    empty.logs.every((line) => !line.includes('private content')),
    true,
  );
  for (const mode of ['nonempty', 'mixed', 'error', 'stall']) {
    const f = fixture(mode);
    f.monitor.observe();
    await wait(80);
    equal(f.notifications, 0);
    f.stop();
  }
  const cancelled = fixture();
  cancelled.monitor.observe();
  cancelled.monitor.cancel();
  await wait(30);
  equal(cancelled.calls, 0);
  const disabled = fixture();
  disabled.stop();
  disabled.monitor.observe();
  await wait(30);
  equal(disabled.calls, 0);
  const replaced = fixture('stall');
  replaced.monitor.observe();
  await wait(3);
  replaced.monitor.cancel();
  await wait(30);
  equal(replaced.notifications, 0);
  const image = fixture();
  image.selection.get_mimetypes = () => ['image/png'];
  image.monitor.observe();
  await wait(30);
  equal(image.calls, 0);
  print(`Clipboard diagnostics: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => (failure = error))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
