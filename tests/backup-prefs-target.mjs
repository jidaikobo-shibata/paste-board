import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { addBackupPreferences } from '../backupPrefs.js';
import { BACKUP_PATH, BACKUP_INTERFACE } from '../backup.js';
import { _ } from '../i18n.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(0, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const call = () =>
  new Promise((resolve, reject) =>
    Gio.DBus.session.call(
      'org.gnome.Shell',
      BACKUP_PATH,
      BACKUP_INTERFACE,
      'Export',
      null,
      null,
      Gio.DBusCallFlags.NONE,
      30000,
      null,
      (connection, result) => {
        try {
          resolve(connection.call_finish(result).deep_unpack()[0]);
        } catch (error) {
          reject(error);
        }
      },
    ),
  );
const root = GLib.get_user_cache_dir();
const descendants = (widget) => {
  const all = [widget];
  for (
    let child = widget.get_first_child?.();
    child;
    child = child.get_next_sibling()
  )
    all.push(...descendants(child));
  return all;
};
const wait = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(30);
  }
  throw Error('Backup UI timed out');
};
const originalShow = Gtk.FileChooserNative.prototype.show;
const app = new Adw.Application({
  application_id: 'org.pasteboard.BackupTest',
});
app.connect('activate', async () => {
  try {
    const schema = Gio.SettingsSchemaSource.new_from_directory(
      GLib.getenv('PASTE_BOARD_TEST_REPO') + '/schemas',
      Gio.SettingsSchemaSource.get_default(),
      false,
    ).lookup('org.gnome.shell.extensions.paste-board', false);
    const settings = new Gio.Settings({ settings_schema: schema });
    const window = new Adw.PreferencesWindow({
      application: app,
      default_width: 620,
      default_height: 600,
    });
    const page = new Adw.PreferencesPage();
    addBackupPreferences(window, settings, page);
    window.add(page);
    window.present();
    const json = await call();
    const exported = JSON.parse(json);
    if ('history' in exported || exported.sets.length !== 2)
      throw Error('Export included unexpected data');
    const backupPath = root + '/exported-backup.json';
    GLib.file_set_contents(backupPath, 'previous test file');
    Gio.File.new_for_path(backupPath).set_attribute_uint32(
      'unix::mode',
      0o644,
      Gio.FileQueryInfoFlags.NONE,
      null,
    );
    Gtk.FileChooserNative.prototype.show = function () {
      if (this.get_action() === Gtk.FileChooserAction.SAVE) {
        this.set_current_folder(Gio.File.new_for_path(root));
        this.set_current_name('exported-backup.json');
      } else this.set_file(Gio.File.new_for_path(backupPath));
      GLib.timeout_add(0, 150, () => {
        this.emit('response', Gtk.ResponseType.ACCEPT);
        return GLib.SOURCE_REMOVE;
      });
    };
    descendants(window)
      .find(
        (widget) =>
          widget instanceof Gtk.Button && widget.label === _('Export…'),
      )
      .emit('clicked');
    await wait(() => {
      try {
        return (
          JSON.parse(
            new TextDecoder().decode(GLib.file_get_contents(backupPath)[1]),
          ).format === 'paste-board'
        );
      } catch {
        return false;
      }
    });
    const saved = JSON.parse(
      new TextDecoder().decode(GLib.file_get_contents(backupPath)[1]),
    );
    if (JSON.stringify(saved) !== JSON.stringify(exported))
      throw Error('Exported file differs from snapshot');
    const mode = Gio.File.new_for_path(backupPath)
      .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
      .get_attribute_uint32('unix::mode');
    if ((mode & 0o777) !== 0o600) throw Error('Backup is not private');
    await delay(100);
    descendants(window)
      .find(
        (widget) =>
          widget instanceof Gtk.Button && widget.label === _('Import…'),
      )
      .emit('clicked');
    let dialog;
    await wait(() => {
      dialog = Gtk.Window.list_toplevels().find(
        (w) => w instanceof Gtk.Dialog && w.title === _('Import paste sets'),
      );
      return dialog;
    });
    await delay(100);
    dialog.get_widget_for_response(Gtk.ResponseType.ACCEPT).emit('clicked');
    let imported;
    for (let i = 0; i < 100; i++) {
      await delay(50);
      imported = JSON.parse(await call());
      if (imported.sets.length === 4) break;
    }
    if (imported.sets.length !== 4)
      throw Error('Import confirmation did not add sets');
    const generated = imported.sets.filter((set) => set.kind === 'generated');
    if (generated[1].runOnOpen !== false || generated[1].runOnSearch !== false)
      throw Error('Imported generator is automatic');
    if (
      imported.sets[2].items.find((item) => item.kind === 'command')
        .previewOnOpen !== false
    )
      throw Error('Imported command preview is enabled');
    GLib.file_set_contents(root + '/backup-prefs-result', 'PASS');
  } catch (error) {
    console.error(error);
    GLib.file_set_contents(root + '/backup-prefs-result', 'FAIL');
  } finally {
    Gtk.FileChooserNative.prototype.show = originalShow;
    app.quit();
  }
});
app.run([]);
