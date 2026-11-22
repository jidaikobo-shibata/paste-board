import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
  const cancel = new Gtk.Button({
    label: _('Cancel diagnostic'),
    visible: false,
  });
  buttons.append(capture);
  buttons.append(cancel);
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
  let captureId = null;
  let cancelling = false;
  const updateAvailability = () => {
    const privateMode = settings.get_boolean('private-mode');
    capture.sensitive = !captureId && !privateMode;
    cancel.visible = Boolean(captureId);
    cancel.sensitive = !cancelling;
    capture.tooltip_text = privateMode
      ? _('Clipboard diagnostics are unavailable in private mode.')
      : null;
  };
  const privateChanged = settings.connect(
    'changed::private-mode',
    updateAvailability,
  );
  updateAvailability();
  const request = new Gio.Cancellable();
  const cancelCapture = () => {
    if (!captureId || cancelling) return;
    cancelling = true;
    updateAvailability();
    Gio.DBus.session.call(
      'org.gnome.Shell',
      DIAGNOSTIC_PATH,
      DIAGNOSTIC_INTERFACE,
      'Cancel',
      new GLib.Variant('(s)', [captureId]),
      null,
      Gio.DBusCallFlags.NO_AUTO_START,
      5000,
      null,
      (connection, result) => {
        try {
          connection.call_finish(result);
        } catch (error) {
          if (!closed && captureId) {
            status.label =
              _('Could not cancel the diagnostic.') + '\n' + error.message;
            cancelling = false;
            updateAvailability();
          }
        }
      },
    );
  };
  cancel.connect('clicked', cancelCapture);
  window.connect('close-request', () => {
    if (closed) return false;
    cancelCapture();
    closed = true;
    settings.disconnect(privateChanged);
    request.cancel();
    return false;
  });
  capture.connect('clicked', () => {
    if (closed || captureId || !capture.sensitive) return;
    captureId = GLib.uuid_string_random();
    updateAvailability();
    status.label = _('Diagnosing…');
    Gio.DBus.session.call(
      'org.gnome.Shell',
      DIAGNOSTIC_PATH,
      DIAGNOSTIC_INTERFACE,
      'Capture',
      new GLib.Variant('(s)', [captureId]),
      null,
      Gio.DBusCallFlags.NONE,
      30000,
      null,
      (connection, result) => {
        try {
          const [path] = connection.call_finish(result).deep_unpack();
          if (!closed)
            status.label = _('Diagnostic record saved.') + '\n' + path;
        } catch (error) {
          if (!closed) {
            const name = Gio.DBusError.get_remote_error(error);
            if (name === DIAGNOSTIC_INTERFACE + '.Cancelled')
              status.label = _('Diagnostic cancelled.');
            else if (
              [
                'UNKNOWN_METHOD',
                'UNKNOWN_OBJECT',
                'UNKNOWN_INTERFACE',
                'SERVICE_UNKNOWN',
                'NAME_HAS_NO_OWNER',
              ].some((code) =>
                error.matches(Gio.DBusError, Gio.DBusError[code]),
              )
            )
              status.label = _(
                'Clipboard diagnostics are unavailable. Enable or reload Paste Board.',
              );
            else {
              const unavailable =
                name === DIAGNOSTIC_INTERFACE + '.Unavailable';
              if (name) Gio.DBusError.strip_remote_error(error);
              status.label = unavailable
                ? error.message
                : _('Could not save the diagnostic record.') +
                  '\n' +
                  error.message;
            }
          }
        } finally {
          captureId = null;
          cancelling = false;
          if (!closed) updateAvailability();
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
