import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(0, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const assert = (v, message) => {
  if (!v) throw Error(message);
};
export default class extends Extension {
  enable() {
    this.timer = GLib.timeout_add(0, 1800, () => {
      this.timer = null;
      this.check()
        .then(() => this.finish('PASS'))
        .catch((error) => {
          console.error(error);
          this.finish('FAIL');
        });
      return GLib.SOURCE_REMOVE;
    });
  }
  disable() {
    if (this.timer) GLib.Source.remove(this.timer);
    this.target?.force_exit();
  }
  finish(result) {
    this.target?.force_exit();
    GLib.file_set_contents(GLib.get_user_cache_dir() + '/result', result);
  }
  async check() {
    const extension = Main.extensionManager.lookup(
      'paste-board@jidaikobo.shibata',
    );
    const owner = extension.stateObj.clipboardIndicator;
    assert(
      !owner.settings.get_boolean('debug-mode'),
      'Unexpected enabled debug',
    );
    const { DIAGNOSTIC_PATH, DIAGNOSTIC_INTERFACE, diagnosticDirectory } =
      await import(`file://${extension.path}/clipboardDiagnostics.js`);
    const call = () =>
      new Promise((resolve, reject) =>
        Gio.DBus.session.call(
          'org.gnome.Shell',
          DIAGNOSTIC_PATH,
          DIAGNOSTIC_INTERFACE,
          'Capture',
          null,
          null,
          Gio.DBusCallFlags.NONE,
          15000,
          null,
          (source, result) => {
            try {
              resolve(source.call_finish(result));
            } catch (error) {
              reject(error);
            }
          },
        ),
      );
    let rejected = false;
    try {
      await call();
    } catch {
      rejected = true;
    }
    assert(rejected, 'Capture allowed while disabled');
    const folder = Gio.File.new_for_path(diagnosticDirectory());
    assert(!folder.query_exists(null), 'Disabled diagnostic wrote data');
    const service = owner._diagnosticService;
    const snapshot = service.snapshot;
    let readStarted = false;
    service.snapshot = () => ({
      selection: {
        connect: () => 1,
        disconnect() {},
        get_mimetypes: () => ['text/plain'],
        transfer_finish() {
          throw Error('Cancelled fixture transfer');
        },
        transfer_async(_type, _mime, _limit, _output, cancellable, callback) {
          readStarted = true;
          cancellable.connect(() =>
            GLib.idle_add(0, () => {
              callback(this, {});
              return GLib.SOURCE_REMOVE;
            }),
          );
        },
      },
      type: Meta.SelectionType.SELECTION_CLIPBOARD,
      historyText: 'Synthetic history',
    });
    try {
      owner.settings.set_boolean('debug-mode', true);
      owner.settings.set_boolean('private-mode', true);
      assert(
        await call().then(
          () => false,
          () => true,
        ),
        'Private capture accepted',
      );
      assert(!readStarted, 'Private capture started reading');
      owner.settings.set_boolean('private-mode', false);
      const cancelled = call().then(
        () => false,
        () => true,
      );
      for (let i = 0; i < 100 && !readStarted; i++) await delay(10);
      assert(readStarted, 'Fixture capture did not start');
      owner.settings.set_boolean('private-mode', true);
      assert(
        await cancelled,
        'Switching to private mode did not cancel capture',
      );
      assert(!folder.query_exists(null), 'Cancelled capture wrote data');
    } finally {
      owner.settings.set_boolean('debug-mode', false);
      owner.settings.set_boolean('private-mode', false);
      service.snapshot = snapshot;
    }
    const selection = owner.selection;
    const source = Meta.SelectionSourceMemory.new(
      'text/plain;charset=utf-8',
      new GLib.Bytes(new TextEncoder().encode('Diagnostic fixture 日本語\n')),
    );
    selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
    for (
      let i = 0;
      i < 100 && owner.entries.last()?.text !== 'Diagnostic fixture 日本語\n';
      i++
    )
      await delay(30);
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.NONE,
    });
    launcher.setenv(
      'WAYLAND_DISPLAY',
      GLib.getenv('PASTE_BOARD_TEST_DISPLAY'),
      true,
    );
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    this.target = launcher.spawnv([
      'gjs',
      '-m',
      extension.path + '/tests/diagnostic-prefs-target.mjs',
    ]);
    const result = GLib.get_user_cache_dir() + '/diagnostic-prefs-result';
    for (
      let i = 0;
      i < 300 && !GLib.file_test(result, GLib.FileTest.EXISTS);
      i++
    )
      await delay(40);
    assert(GLib.file_test(result, GLib.FileTest.EXISTS), 'Prefs test timeout');
    assert(
      new TextDecoder().decode(GLib.file_get_contents(result)[1]) === 'PASS',
      'Prefs diagnostic failed',
    );
    const { readClipboardText } = await import(
      `file://${extension.path}/clipboardRead.js`
    );
    assert(
      (await readClipboardText(
        selection,
        Meta.SelectionType.SELECTION_CLIPBOARD,
      ).promise) === 'Diagnostic fixture 日本語\n',
      'Diagnostic changed clipboard',
    );
    rejected = false;
    try {
      await call();
    } catch {
      rejected = true;
    }
    assert(rejected, 'Diagnostic remained enabled');
  }
}
