import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { addDiagnosticPreferences } from '../diagnosticPrefs.js';
import { _ } from '../i18n.js';
const root = GLib.get_user_cache_dir();
const repo = GLib.path_get_dirname(
  GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
);
const settings = new Gio.Settings({
  settings_schema: Gio.SettingsSchemaSource.new_from_directory(
    repo + '/schemas',
    Gio.SettingsSchemaSource.get_default(),
    false,
  ).lookup('org.gnome.shell.extensions.paste-board', false),
});
function assert(v, message) {
  if (!v) throw Error(message);
}
const widgets = (w) => {
  const result = [w];
  for (
    let child = w.get_first_child?.();
    child;
    child = child.get_next_sibling()
  )
    result.push(...widgets(child));
  return result;
};
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(0, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const app = new Adw.Application({
  application_id: 'org.example.PasteBoardDiagnosticTest',
});
app.connect('activate', () => {
  const window = new Adw.PreferencesWindow({ application: app });
  const page = new Adw.PreferencesPage();
  window.add(page);
  addDiagnosticPreferences(window, settings, page);
  // Real GTK widgets, deliberately not presented on the user's desktop.
  const check = async () => {
    assert(!settings.get_boolean('debug-mode'), 'Debug must default off');
    const controls = widgets(page);
    const capture = controls.find(
      (w) => w instanceof Gtk.Button && w.label === _('Diagnose and save'),
    );
    assert(
      capture && !capture.get_parent().get_parent().visible,
      'Diagnostic controls must be hidden',
    );
    const toggle = controls.find((w) => w instanceof Adw.SwitchRow);
    toggle.active = true;
    assert(settings.get_boolean('debug-mode'), 'Switch did not enable debug');
    assert(capture.get_parent().get_parent().visible, 'Tools not revealed');
    Gio.Settings.sync();
    await delay(300);
    capture.emit('clicked');
    const status = controls.find(
      (w) => w instanceof Gtk.Label && w.label === _('Diagnosing…'),
    );
    for (
      let i = 0;
      i < 200 && !status.label.startsWith(_('Diagnostic record saved.'));
      i++
    )
      await delay(30);
    assert(
      status.label.startsWith(_('Diagnostic record saved.')),
      status.label,
    );
    const path = status.label.split('\n')[1];
    const report = JSON.parse(
      new TextDecoder().decode(GLib.file_get_contents(path)[1]),
    );
    assert(
      report.clipboard.results.some(
        (r) => r.text === 'Diagnostic fixture 日本語\n',
      ),
      'Actual clipboard text missing',
    );
    assert(
      report.historyHead.text === 'Diagnostic fixture 日本語\n',
      'History text missing',
    );
    toggle.active = false;
    Gio.Settings.sync();
    await delay(300);
    assert(!capture.get_parent().get_parent().visible, 'Tools remain visible');
    GLib.file_set_contents(root + '/diagnostic-prefs-result', 'PASS');
  };
  check()
    .catch((error) => {
      console.error(error);
      GLib.file_set_contents(
        root + '/diagnostic-prefs-result',
        'FAIL: ' + error.message,
      );
    })
    .finally(() => {
      window.destroy();
      app.quit();
    });
});
app.run([]);
