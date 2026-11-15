import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { _ } from './i18n.js';
import {
  DIAGNOSTIC_PATH,
  DIAGNOSTIC_INTERFACE,
  diagnosticDirectory,
} from './clipboardDiagnostics.js';

export function addDiagnosticPreferences(window, settings, page) {
  const group = new Adw.PreferencesGroup({
    title: _('Debug mode'),
    description: _(
      'Show tools for investigating problems. Not needed for normal use.',
    ),
  });
  const toggle = new Adw.SwitchRow({ title: _('Enable debug mode') });
  settings.bind('debug-mode', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
  group.add(toggle);
  const content = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 12,
  });
  const description = new Gtk.Label({
    label: _(
      'Clipboard diagnostic: when pasting fails, run this before copying again. Records the available formats, retrieval results and text, and the text at the top of history. Does not change the clipboard.',
    ),
    wrap: true,
    xalign: 0,
  });
  content.append(description);
  content.append(
    new Gtk.Label({
      label: _(
        'Records may contain passwords or personal information. They are saved locally and are not sent automatically. Review their contents before sharing. Diagnostics cannot determine whether an application pasted successfully.',
      ),
      wrap: true,
      xalign: 0,
    }),
  );
  const buttons = new Gtk.Box({ spacing: 12 });
  const capture = new Gtk.Button({ label: _('Diagnose and save') });
  const open = new Gtk.Button({ label: _('Open diagnostic folder') });
  buttons.append(capture);
  buttons.append(open);
  content.append(buttons);
  const status = new Gtk.Label({
    label: '',
    wrap: true,
    selectable: true,
    xalign: 0,
  });
  content.append(status);
  group.add(content);
  settings.bind('debug-mode', content, 'visible', Gio.SettingsBindFlags.GET);
  let closed = false;
  const request = new Gio.Cancellable();
  window.connect('close-request', () => {
    closed = true;
    request.cancel();
    return false;
  });
  capture.connect('clicked', () => {
    capture.sensitive = false;
    status.label = _('Diagnosing…');
    Gio.DBus.session.call(
      'org.gnome.Shell',
      DIAGNOSTIC_PATH,
      DIAGNOSTIC_INTERFACE,
      'Capture',
      null,
      null,
      Gio.DBusCallFlags.NONE,
      30000,
      request,
      (connection, result) => {
        try {
          const [path] = connection.call_finish(result).deep_unpack();
          if (!closed)
            status.label = _('Diagnostic record saved.') + '\n' + path;
        } catch (error) {
          if (!closed)
            status.label =
              _(
                'Could not save a diagnostic. Enable Paste Board and try again.',
              ) +
              '\n' +
              error.message;
        } finally {
          if (!closed) capture.sensitive = true;
        }
      },
    );
  });
  open.connect('clicked', () => {
    const folder = Gio.File.new_for_path(diagnosticDirectory());
    if (!folder.query_exists(null)) {
      status.label = _('No diagnostic records yet.');
      return;
    }
    Gio.AppInfo.launch_default_for_uri_async(
      folder.get_uri(),
      null,
      request,
      (_source, result) => {
        try {
          Gio.AppInfo.launch_default_for_uri_finish(result);
        } catch (error) {
          if (!closed) status.label = error.message;
        }
      },
    );
  });
  page.add(group);
}
