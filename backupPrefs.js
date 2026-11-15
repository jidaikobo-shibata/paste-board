import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { _, format } from './i18n.js';
import { readBoundedFile } from './inputLimits.js';
import {
  BACKUP_LIMIT,
  BACKUP_PATH,
  BACKUP_INTERFACE,
  parseBackup,
} from './backup.js';

function call(method, args = null) {
  return new Promise((resolve, reject) =>
    Gio.DBus.session.call(
      'org.gnome.Shell',
      BACKUP_PATH,
      BACKUP_INTERFACE,
      method,
      args,
      null,
      Gio.DBusCallFlags.NONE,
      30000,
      null,
      (connection, result) => {
        try {
          resolve(connection.call_finish(result).deep_unpack());
        } catch (error) {
          const name = Gio.DBusError.get_remote_error(error);
          if (
            [
              'org.freedesktop.DBus.Error.UnknownMethod',
              'org.freedesktop.DBus.Error.UnknownObject',
              'org.freedesktop.DBus.Error.ServiceUnknown',
            ].includes(name)
          )
            reject(
              new Error(_('Enable Paste Board before exporting or importing.')),
            );
          else reject(error);
        }
      },
    ),
  );
}

function chooseFile(parent, save) {
  return new Promise((resolve) => {
    const chooser = new Gtk.FileChooserNative({
      title: save ? _('Export Paste Board') : _('Import Paste Board'),
      transient_for: parent,
      modal: true,
      action: save ? Gtk.FileChooserAction.SAVE : Gtk.FileChooserAction.OPEN,
      accept_label: save ? _('Export') : _('Open'),
      cancel_label: _('Cancel'),
    });
    const filter = new Gtk.FileFilter();
    filter.set_name(_('JSON backup files'));
    filter.add_pattern('*.json');
    chooser.add_filter(filter);
    if (save) chooser.set_current_name('paste-board-backup.json');
    let finished = false;
    const finish = (file) => {
      if (finished) return;
      finished = true;
      parent.disconnect(closeHandler);
      chooser.destroy();
      resolve(file);
    };
    const closeHandler = parent.connect('close-request', () => {
      finish(null);
      return false;
    });
    chooser.connect('response', (_chooser, response) => {
      finish(response === Gtk.ResponseType.ACCEPT ? chooser.get_file() : null);
    });
    chooser.show();
  });
}

function message(parent, title, text) {
  const dialog = new Gtk.MessageDialog({
    transient_for: parent,
    modal: true,
    destroy_with_parent: true,
    text: title,
    secondary_text: text,
    buttons: Gtk.ButtonsType.CLOSE,
    message_type: Gtk.MessageType.INFO,
  });
  dialog.connect('response', () => dialog.destroy());
  dialog.present();
}

export function confirmImport(parent, settings, json) {
  const data = parseBackup(json, settings);
  const dialog = new Gtk.Dialog({
    title: _('Import paste sets'),
    transient_for: parent,
    modal: true,
    destroy_with_parent: true,
    default_width: 520,
  });
  dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
  const accept = dialog.add_button(_('Import'), Gtk.ResponseType.ACCEPT);
  const content = dialog.get_content_area();
  content.spacing = 12;
  for (const side of ['top', 'bottom', 'start', 'end'])
    content['margin_' + side] = 18;
  const summary = new Gtk.Label({
    label: _(
      'Paste sets will be added to your existing tabs. Imported commands will have automatic execution turned off.',
    ),
    wrap: true,
    xalign: 0,
  });
  content.append(summary);
  const lines = data.sets.map(
    (set) =>
      format(_('%s — %d items'), set.name, set.items.length) +
      (set.kind === 'generated'
        ? '\n' + _('Generated tab') + '\n' + set.command
        : ''),
  );
  const preview = new Gtk.TextView({
    editable: false,
    cursor_visible: false,
    wrap_mode: Gtk.WrapMode.WORD_CHAR,
    accessible_role: Gtk.AccessibleRole.TEXT_BOX,
  });
  preview.update_property(
    [Gtk.AccessibleProperty.LABEL],
    [_('Paste sets to import')],
  );
  preview.buffer.text = lines.join('\n\n') || _('No paste sets');
  content.append(
    new Gtk.ScrolledWindow({
      child: preview,
      min_content_height: 180,
      max_content_height: 300,
      propagate_natural_height: true,
    }),
  );
  const preferences = new Gtk.CheckButton({
    label: _('Apply preferences from the backup'),
    active: false,
  });
  const shortcuts = new Gtk.CheckButton({
    label: _('Also apply keyboard shortcuts'),
    active: false,
    sensitive: false,
  });
  preferences.connect('toggled', () => {
    shortcuts.sensitive = preferences.active;
  });
  content.append(preferences);
  content.append(shortcuts);
  const errorLabel = new Gtk.Label({
    label: '',
    wrap: true,
    xalign: 0,
    selectable: true,
  });
  errorLabel.add_css_class('error');
  content.append(errorLabel);
  const operationId = GLib.uuid_string_random();
  let busy = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    parent.disconnect(parentCloseHandler);
    dialog.destroy();
  };
  const parentCloseHandler = parent.connect('close-request', () => {
    close();
    return false;
  });
  dialog.connect('close-request', () => {
    if (!busy) close();
    return true;
  });
  dialog.connect('response', async (_dialog, response) => {
    if (busy) return;
    if (response !== Gtk.ResponseType.ACCEPT) {
      close();
      return;
    }
    busy = true;
    accept.sensitive = preferences.sensitive = shortcuts.sensitive = false;
    dialog.get_widget_for_response(Gtk.ResponseType.CANCEL).sensitive = false;
    errorLabel.label = _('Importing…');
    try {
      await call(
        'Import',
        new GLib.Variant('(sbbs)', [
          json,
          preferences.active,
          preferences.active && shortcuts.active,
          operationId,
        ]),
      );
      if (!closed) {
        close();
        message(
          parent,
          _('Import complete'),
          _(
            'Paste sets were added. Review commands before enabling automatic execution.',
          ),
        );
      }
    } catch (error) {
      if (!closed) errorLabel.label = error.message;
    } finally {
      busy = false;
      if (!closed) {
        accept.sensitive = true;
        dialog.get_widget_for_response(Gtk.ResponseType.CANCEL).sensitive =
          true;
      }
    }
  });
  dialog.present();
  return dialog;
}

export function addBackupPreferences(window, settings, page) {
  const group = new Adw.PreferencesGroup({
    title: _('Export and import'),
    description: _(
      'Save paste sets and preferences. Clipboard history is excluded.',
    ),
  });
  const buttons = new Gtk.Box({ spacing: 12, homogeneous: true });
  const exportButton = new Gtk.Button({ label: _('Export…') });
  const importButton = new Gtk.Button({ label: _('Import…') });
  buttons.append(exportButton);
  buttons.append(importButton);
  group.add(buttons);
  page.add(group);
  let closed = false;
  window.connect('close-request', () => {
    closed = true;
    return false;
  });
  const perform = async (action) => {
    if (closed) return;
    exportButton.sensitive = importButton.sensitive = false;
    try {
      await action();
    } catch (error) {
      if (!closed)
        message(
          window,
          _('Could not transfer Paste Board data'),
          error.message,
        );
    } finally {
      if (!closed) exportButton.sensitive = importButton.sensitive = true;
    }
  };
  exportButton.connect('clicked', () =>
    perform(async () => {
      const file = await chooseFile(window, true);
      if (!file || closed) return;
      const [json] = await call('Export');
      await new Promise((resolve, reject) =>
        file.replace_contents_bytes_async(
          new GLib.Bytes(new TextEncoder().encode(json)),
          null,
          false,
          Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
          null,
          (source, result) => {
            try {
              source.replace_contents_finish(result);
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        ),
      );
    }),
  );
  importButton.connect('clicked', () =>
    perform(async () => {
      const file = await chooseFile(window, false);
      if (!file || closed) return;
      const path = file.get_path();
      if (!path) throw new Error(_('Choose a local backup file.'));
      const json = new TextDecoder('utf-8', { fatal: true }).decode(
        readBoundedFile(path, BACKUP_LIMIT),
      );
      if (!closed) confirmImport(window, settings, json);
    }),
  );
}
