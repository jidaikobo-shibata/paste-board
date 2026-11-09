import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
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
      incidentDirectory:
        GLib.dir_make_tmp('paste-board-incident-test.XXXXXX') + '/incidents',
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
  const copied = '\n"日本語" \\ path\nlast line\n';
  empty.monitor.observe(copied);
  await wait(60);
  equal(empty.notifications, 1);
  equal(empty.calls, 4);
  const incidents = Gio.File.new_for_path(empty.monitor.incidentDirectory);
  const files = incidents.enumerate_children(
    'standard::name,unix::mode',
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
    null,
  );
  const fileInfo = files.next_file(null);
  equal(Boolean(fileInfo), true);
  equal(fileInfo.get_attribute_uint32('unix::mode') & 0o777, 0o600);
  equal(files.next_file(null), null);
  files.close(null);
  const incident = JSON.parse(
    new TextDecoder().decode(
      GLib.file_get_contents(
        incidents.get_child(fileInfo.get_name()).get_path(),
      )[1],
    ),
  );
  equal(incident.text, copied);
  equal(incident.formats.includes('image/png'), true);
  equal(typeof incident.acquiredAt, 'string');
  equal(typeof incident.detectedAt, 'string');
  equal(
    incidents
      .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
      .get_attribute_uint32('unix::mode') & 0o777,
    0o700,
  );
  equal(
    empty.logs.some((line) => line.includes('incident-saved')),
    true,
  );
  equal(
    empty.logs.some((line) => line.includes('日本語')),
    false,
  );
  equal(
    empty.logs.every((line) => !line.includes('private content')),
    true,
  );
  for (const mode of ['nonempty', 'mixed', 'error', 'stall']) {
    const f = fixture(mode);
    f.monitor.observe('normal copy');
    await wait(80);
    equal(f.notifications, 0);
    equal(
      GLib.file_test(f.monitor.incidentDirectory, GLib.FileTest.EXISTS),
      false,
    );
    f.stop();
  }
  const cancelled = fixture();
  cancelled.monitor.observe('cancelled copy');
  cancelled.monitor.cancel();
  await wait(30);
  equal(cancelled.calls, 0);
  equal(
    GLib.file_test(cancelled.monitor.incidentDirectory, GLib.FileTest.EXISTS),
    false,
  );
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
  const failed = fixture();
  const blockedPath =
    GLib.dir_make_tmp('paste-board-incident-blocked.XXXXXX') + '/file';
  GLib.file_set_contents(blockedPath, 'existing file');
  failed.monitor.incidentDirectory = blockedPath;
  failed.monitor.observe('not saved');
  await wait(60);
  equal(failed.notifications, 1);
  equal(
    failed.logs.some((line) => line.includes('incident-save-failed')),
    true,
  );
  equal(
    new TextDecoder().decode(GLib.file_get_contents(blockedPath)[1]),
    'existing file',
  );
  const stale = fixture();
  stale.monitor.cancel();
  await stale.monitor.saveIncident(
    { text: 'stale' },
    stale.monitor.generation - 1,
  );
  equal(
    GLib.file_test(stale.monitor.incidentDirectory, GLib.FileTest.EXISTS),
    false,
  );
  print(`Clipboard diagnostics: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => (failure = error))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
