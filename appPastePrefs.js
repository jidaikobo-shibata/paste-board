import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Adw from 'gi://Adw';
import { _, format } from './i18n.js';
import {
  SETTINGS_KEY,
  PRESETS,
  validAppId,
  validShortcut,
  modifierKey,
  readOverrides,
  writeOverride,
  resolveShortcut,
} from './pasteShortcuts.js';

function gtkModifiers(bits) {
  return (
    (bits & 1 ? Gdk.ModifierType.CONTROL_MASK : 0) |
    (bits & 2 ? Gdk.ModifierType.ALT_MASK : 0) |
    (bits & 4 ? Gdk.ModifierType.SHIFT_MASK : 0) |
    (bits & 8 ? Gdk.ModifierType.SUPER_MASK : 0)
  );
}

function portableModifiers(state) {
  return (
    (state & Gdk.ModifierType.CONTROL_MASK ? 1 : 0) |
    (state & Gdk.ModifierType.ALT_MASK ? 2 : 0) |
    (state & Gdk.ModifierType.SHIFT_MASK ? 4 : 0) |
    (state & Gdk.ModifierType.SUPER_MASK ? 8 : 0)
  );
}

function shortcutLabel(shortcut) {
  return Gtk.accelerator_get_label(
    shortcut.keyval,
    gtkModifiers(shortcut.modifiers),
  );
}

function namedButton(label, icon = null) {
  const button = new Gtk.Button(icon ? { icon_name: icon } : { label });
  button.tooltip_text = label;
  button.valign = Gtk.Align.CENTER;
  button.update_property([Gtk.AccessibleProperty.LABEL], [label]);
  return button;
}

function dialogFor(parent, title) {
  const dialog = new Gtk.Dialog({
    title,
    transient_for: parent,
    modal: true,
    destroy_with_parent: true,
    default_width: 480,
  });
  dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
  const content = dialog.get_content_area();
  content.spacing = 12;
  for (const side of ['top', 'bottom', 'start', 'end'])
    content['margin_' + side] = 18;
  return dialog;
}

export function editApplicationShortcut(parent, settings, appId, name) {
  const dialog = dialogFor(parent, _('Application paste shortcut'));
  dialog.add_button(_('Save'), Gtk.ResponseType.APPLY);
  dialog.set_default_response(Gtk.ResponseType.APPLY);
  const content = dialog.get_content_area();
  content.append(new Gtk.Label({ label: name, xalign: 0 }));
  content.append(
    new Gtk.Label({ label: appId, xalign: 0, selectable: true, wrap: true }),
  );
  const choices = new Gtk.ComboBoxText();
  choices.update_property(
    [Gtk.AccessibleProperty.LABEL],
    [_('Paste shortcut')],
  );
  for (let i = 0; i < PRESETS.length; i++)
    choices.append(String(i), shortcutLabel(PRESETS[i]));
  choices.append('custom', _('Custom shortcut'));
  content.append(choices);
  const capture = namedButton(_('Record shortcut'));
  content.append(capture);
  const error = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
  error.add_css_class('error');
  content.append(error);
  const explain = new Gtk.Label({
    label: _(
      'Set the same paste shortcut in the application. This setting changes only the keys sent by Paste Board.',
    ),
    xalign: 0,
    wrap: true,
  });
  content.append(explain);
  let shortcut = resolveShortcut(readOverrides(settings), appId);
  let recording = false;
  const preset = PRESETS.findIndex(
    (value) =>
      value.keyval === shortcut.keyval &&
      value.modifiers === shortcut.modifiers,
  );
  const showError = (message) => {
    error.label = message;
    error.visible = true;
  };
  const update = () => {
    recording = false;
    capture.visible = choices.get_active_id() === 'custom';
    capture.label = shortcutLabel(shortcut);
    capture.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [format(_('Record shortcut (current: %s)'), shortcutLabel(shortcut))],
    );
    error.visible = false;
  };
  choices.connect('changed', () => {
    const id = choices.get_active_id();
    if (id !== 'custom') shortcut = { ...PRESETS[Number(id)] };
    update();
  });
  choices.set_active_id(preset < 0 ? 'custom' : String(preset));
  capture.connect('clicked', () => {
    recording = true;
    capture.label = _('Press a shortcut… (Esc to cancel)');
    capture.update_property([Gtk.AccessibleProperty.LABEL], [capture.label]);
    capture.grab_focus();
    error.visible = false;
  });
  const keys = new Gtk.EventControllerKey();
  keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  keys.connect('key-pressed', (_controller, keyval, keycode, state) => {
    if (!recording) return false;
    const bits = portableModifiers(state);
    if (keyval === Gdk.KEY_Escape && bits === 0) {
      update();
      return true;
    }
    if (modifierKey(keyval)) return true;
    const unsupported =
      state & (Gdk.ModifierType.META_MASK | Gdk.ModifierType.HYPER_MASK);
    const candidate = { keyval: Gdk.keyval_to_lower(keyval), modifiers: bits };
    if (
      unsupported ||
      !validShortcut(candidate) ||
      !Gtk.accelerator_valid(candidate.keyval, gtkModifiers(bits))
    ) {
      showError(_('Use Ctrl, Alt, Shift or Super with one other key.'));
      return true;
    }
    shortcut = candidate;
    update();
    return true;
  });
  capture.add_controller(keys);
  dialog.connect('response', (_dialog, response) => {
    if (response === Gtk.ResponseType.APPLY) {
      if (recording) {
        showError(_('Finish recording the shortcut first.'));
        return;
      }
      try {
        writeOverride(settings, appId, shortcut);
      } catch (e) {
        showError(e.message);
        return;
      }
    }
    dialog.destroy();
  });
  dialog.present();
  return dialog;
}

function chooseApplication(parent, settings) {
  const dialog = dialogFor(parent, _('Choose an application'));
  const content = dialog.get_content_area();
  const search = new Gtk.SearchEntry({
    placeholder_text: _('Search applications…'),
  });
  search.update_property(
    [Gtk.AccessibleProperty.LABEL],
    [_('Search applications')],
  );
  content.append(search);
  const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
  const scroll = new Gtk.ScrolledWindow({
    child: list,
    min_content_height: 300,
    hscrollbar_policy: Gtk.PolicyType.NEVER,
  });
  content.append(scroll);
  const seen = new Set();
  const apps = Gio.AppInfo.get_all()
    .filter((app) => {
      const id = app.get_id();
      if (!validAppId(id) || seen.has(id) || !app.should_show()) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
  for (const app of apps) {
    const row = new Gtk.ListBoxRow();
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 3,
      margin_top: 8,
      margin_bottom: 8,
      margin_start: 8,
      margin_end: 8,
    });
    box.append(
      new Gtk.Label({ label: app.get_display_name(), xalign: 0, wrap: true }),
    );
    const idLabel = new Gtk.Label({
      label: app.get_id(),
      xalign: 0,
      wrap: true,
    });
    idLabel.add_css_class('dim-label');
    box.append(idLabel);
    row.set_child(box);
    row.app = app;
    list.append(row);
  }
  list.set_filter_func((row) =>
    (row.app.get_display_name() + ' ' + row.app.get_id())
      .toLowerCase()
      .includes(search.text.toLowerCase()),
  );
  search.connect('search-changed', () => list.invalidate_filter());
  list.connect('row-activated', (_list, row) => {
    const app = row.app;
    dialog.destroy();
    editApplicationShortcut(
      parent,
      settings,
      app.get_id(),
      app.get_display_name(),
    );
  });
  dialog.connect('response', () => dialog.destroy());
  dialog.present();
}

export function addApplicationPastePreferences(window, settings, page) {
  const group = new Adw.PreferencesGroup({
    title: _('Application paste shortcuts'),
    description: _(
      'Application overrides take priority over automatic paste keys. Remove an override to restore automatic behavior.',
    ),
  });
  const add = namedButton(_('Add application'), 'list-add-symbolic');
  add.connect('clicked', () => chooseApplication(window, settings));
  group.header_suffix = add;
  let rows = [];
  const render = () => {
    for (const row of rows) group.remove(row);
    rows = [];
    for (const [appId, shortcut] of Object.entries(
      readOverrides(settings),
    ).sort(([a], [b]) => a.localeCompare(b))) {
      const app = GioUnix.DesktopAppInfo.new(appId);
      const name = app?.get_display_name() || appId;
      const row = new Adw.ActionRow({
        title: name,
        subtitle: appId,
        use_markup: false,
      });
      const edit = namedButton(shortcutLabel(shortcut));
      edit.update_property(
        [Gtk.AccessibleProperty.LABEL],
        [
          format(
            _('%s: %s'),
            format(_('Change paste shortcut for %s'), name),
            shortcutLabel(shortcut),
          ),
        ],
      );
      edit.connect('clicked', () =>
        editApplicationShortcut(window, settings, appId, name),
      );
      const remove = namedButton(
        format(_('Remove shortcut for %s'), name),
        'edit-delete-symbolic',
      );
      remove.connect('clicked', () => {
        try {
          writeOverride(settings, appId, null);
        } catch (error) {
          const message = dialogFor(
            window,
            _('Could not save application shortcuts.'),
          );
          message
            .get_content_area()
            .append(new Gtk.Label({ label: error.message, wrap: true }));
          message.connect('response', () => message.destroy());
          message.present();
        }
      });
      row.add_suffix(edit);
      row.add_suffix(remove);
      row.activatable_widget = edit;
      group.add(row);
      rows.push(row);
    }
  };
  render();
  let signal = settings.connect('changed::' + SETTINGS_KEY, render);
  window.connect('close-request', () => {
    if (signal) settings.disconnect(signal);
    signal = 0;
    return false;
  });
  page.add(group);
  return group;
}
