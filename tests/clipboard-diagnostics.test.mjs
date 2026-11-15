import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { collectDiagnostic, saveDiagnostic } from '../clipboardDiagnostics.js';
import { MAX_TEXT_BYTES } from '../inputLimits.js';
let checks = 0;
function equal(a, b) {
  checks++;
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
async function rejects(fn) {
  let failed = false;
  try {
    await fn();
  } catch {
    failed = true;
  }
  equal(failed, true);
}
function fake(formats, value) {
  return {
    connected: false,
    calls: [],
    connect(_signal, cb) {
      this.changed = cb;
      this.connected = true;
      return 1;
    },
    disconnect() {
      this.connected = false;
    },
    get_mimetypes() {
      return formats;
    },
    transfer_finish(result) {
      if (result.error) throw result.error;
    },
    transfer_async(type, mime, limit, output, cancel, callback) {
      this.calls.push(mime);
      const bytes = value[mime] || new Uint8Array();
      GLib.idle_add(0, () => {
        if (cancel.is_cancelled())
          callback(this, { error: Error('Cancelled') });
        else {
          output.write_all(bytes.subarray(0, limit), null);
          this.onRead?.(type);
          callback(this, {});
        }
        return GLib.SOURCE_REMOVE;
      });
    },
  };
}
async function main() {
  const bytes = new TextEncoder().encode('秘密\n日本語\n');
  const selection = fake(
    ['text/plain', 'image/png', 'text/html', 'UTF8_STRING'],
    { 'text/plain': bytes },
  );
  const report = await collectDiagnostic(
    selection,
    1,
    '履歴\n',
    new Gio.Cancellable(),
  );
  equal(report.historyHead.text, '履歴\n');
  equal(report.historyHead.source, 'previously-recorded-history');
  equal(selection.calls, ['text/plain', 'UTF8_STRING']);
  equal(report.clipboard.results[0].text, '秘密\n日本語\n');
  equal(report.clipboard.results[0].bytes, bytes.length);
  equal(report.clipboard.results[1].text, '');
  equal(report.clipboard.results[1].bytes, 0);
  equal(selection.connected, false);
  const latin = fake(['STRING'], { STRING: new Uint8Array([233]) });
  equal(
    (await collectDiagnostic(latin, 1, null, new Gio.Cancellable())).clipboard
      .results[0].text,
    'é',
  );
  const changed = fake(['text/plain', 'UTF8_STRING'], { 'text/plain': bytes });
  changed.onRead = (type) => changed.changed(changed, type);
  const changing = await collectDiagnostic(
    changed,
    1,
    null,
    new Gio.Cancellable(),
  );
  equal(changing.clipboard.changedDuringCapture, true);
  equal(changing.clipboard.incomplete, true);
  equal(changed.calls.length, 1);
  const cancel = new Gio.Cancellable();
  cancel.cancel();
  await rejects(() => collectDiagnostic(selection, 1, null, cancel));
  equal(selection.connected, false);
  const huge = fake(['text/plain', 'UTF8_STRING'], {
    'text/plain': new Uint8Array(MAX_TEXT_BYTES + 1),
  });
  const limited = await collectDiagnostic(huge, 1, null, new Gio.Cancellable());
  equal(limited.clipboard.results[0].truncated, true);
  equal('text' in limited.clipboard.results[0], false);
  equal(huge.calls.length, 1);
  const invalid = fake(['text/plain'], { 'text/plain': new Uint8Array([255]) });
  equal(
    Boolean(
      (await collectDiagnostic(invalid, 1, null, new Gio.Cancellable()))
        .clipboard.results[0].error,
    ),
    true,
  );
  const interrupted = fake(['text/plain'], { 'text/plain': bytes });
  const stop = new Gio.Cancellable();
  interrupted.onRead = () => stop.cancel();
  await rejects(() => collectDiagnostic(interrupted, 1, null, stop));
  equal(interrupted.connected, false);
  const stalled = fake(['text/plain'], {});
  stalled.transfer_async = (
    _type,
    _mime,
    _limit,
    _output,
    cancel,
    callback,
  ) => {
    const signal = cancel.connect(() => {
      GLib.idle_add(0, () => {
        cancel.disconnect(signal);
        callback(stalled, { error: Error('Timed out') });
        return GLib.SOURCE_REMOVE;
      });
    });
  };
  const timeout = await collectDiagnostic(
    stalled,
    1,
    null,
    new Gio.Cancellable(),
  );
  equal(timeout.clipboard.results[0].error, 'Timed out');
  equal(timeout.clipboard.results[0].bytes, 0);
  equal(stalled.connected, false);
  const root = GLib.dir_make_tmp('paste-board-diagnostics-XXXXXX');
  const dir = root + '/diagnostics';
  const path = await saveDiagnostic(report, new Gio.Cancellable(), dir);
  const file = Gio.File.new_for_path(path);
  const read = JSON.parse(
    new TextDecoder().decode(file.load_contents(null)[1]),
  );
  equal(read.historyHead.text, '履歴\n');
  equal(read.clipboard.results[0].text, '秘密\n日本語\n');
  const mode = (path) =>
    Gio.File.new_for_path(path)
      .query_info('unix::mode', 0, null)
      .get_attribute_uint32('unix::mode') & 0o777;
  equal(mode(dir), 0o700);
  equal(mode(path), 0o600);
  await rejects(() => saveDiagnostic(report, cancel, dir));
  equal(GLib.file_get_contents(path)[0], true);
  const symlink = root + '/link';
  Gio.File.new_for_path(symlink).make_symbolic_link(dir, null);
  await rejects(() => saveDiagnostic(report, new Gio.Cancellable(), symlink));
  GLib.unlink(symlink);
  GLib.unlink(path);
  GLib.rmdir(dir);
  GLib.rmdir(root);
  print(`Manual clipboard diagnostics: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((e) => (failure = e))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
