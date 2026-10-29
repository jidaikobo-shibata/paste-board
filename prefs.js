import { _, format } from './i18n.js';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Fields from './settingsFields.js';
import { modifierLabel } from './shortcutModifiers.js';

export default class ClipboardHistoryPrefs extends ExtensionPreferences {
  // fillPreferencesWindow() is passed a Adw.PreferencesWindow,
  // we need to wrap our widget in a Adw.PreferencesPage and Adw.PreferencesGroup
  // ourselves.
  // It would be great to port the preferences to standard Adw widgets.
  // https://gjs.guide/extensions/development/preferences.html#prefs-js
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const main = new Gtk.Grid({
      margin_top: 10,
      margin_bottom: 10,
      margin_start: 10,
      margin_end: 10,
      row_spacing: 12,
      column_spacing: 18,
      column_homogeneous: false,
      row_homogeneous: false,
    });
    const field_size = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 100_000,
        step_increment: 100,
      }),
    });
    const window_width_percentage = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 100,
        step_increment: 5,
      }),
    });
    const field_topbar_preview_size = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 100,
        step_increment: 10,
      }),
    });
    const field_display_mode = new Gtk.ComboBox({
      model: this._create_display_mode_options(),
    });

    const rendererText = new Gtk.CellRendererText();
    field_display_mode.pack_start(rendererText, false);
    field_display_mode.add_attribute(rendererText, 'text', 0);
    const field_disable_down_arrow = new Gtk.Switch();
    const field_cache_disable = new Gtk.Switch();
    const field_notification_toggle = new Gtk.ComboBoxText();
    for (const label of [
      _('Do not show'),
      _('Highlight the icon'),
      _('Highlight the icon and show a bubble'),
      _('Highlight the entire top bar'),
      _('System notification'),
      _('Highlight the entire top bar and show a bubble'),
    ])
      field_notification_toggle.append_text(label);
    const field_strip_text = new Gtk.Switch();
    const field_paste_on_selection = new Gtk.Switch();
    const field_process_primary_selection = new Gtk.Switch();
    const field_keybinding = createKeybindingWidget(settings);
    addKeybinding(
      field_keybinding.model,
      settings,
      'toggle-menu',
      _('Open the panel'),
    );

    const field_keybinding_activation = new Gtk.Switch();
    field_keybinding_activation.connect('notify::active', (widget) => {
      field_keybinding.set_sensitive(widget.active);
    });

    const sizeLabel = new Gtk.Label({
      label: _('Max number of items'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const windowWidthPercentageLabel = new Gtk.Label({
      label: _('Panel width (%)'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const cacheDisableLabel = new Gtk.Label({
      label: _('Clear history on logout\n(Paste sets are kept)'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const notificationLabel = new Gtk.Label({
      label: _('Copy feedback'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const keybindingLabel = new Gtk.Label({
      label: _('Panel opening shortcut'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const topbarPreviewLabel = new Gtk.Label({
      label: _('Number of characters in status bar'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const displayModeLabel = new Gtk.Label({
      label: _('What to show in status bar'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const disableDownArrowLabel = new Gtk.Label({
      label: _('Remove down arrow in status bar'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const stripTextLabel = new Gtk.Label({
      label: _('Trim leading and trailing whitespace'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const pasteOnSelectionLabel = new Gtk.Label({
      label: _('Paste on Enter or click'),
      hexpand: true,
      halign: Gtk.Align.START,
    });
    const processPrimarySelection = new Gtk.Label({
      label: _('Also save selected text to history'),
      hexpand: true,
      halign: Gtk.Align.START,
    });

    const addRow = ((main) => {
      let row = 0;
      return (label, input) => {
        let inputWidget = input;

        if (input instanceof Gtk.Switch) {
          input.valign = Gtk.Align.CENTER;
          input.vexpand = false;
          inputWidget = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            valign: Gtk.Align.CENTER,
          });
          inputWidget.append(input);
        }

        if (label) {
          // GTK exposes this association as LABELLED_BY to assistive tools.
          label.set_mnemonic_widget(input);
          main.attach(label, 0, row, 1, 1);
          main.attach(inputWidget, 1, row, 1, 1);
        } else {
          main.attach(inputWidget, 0, row, 2, 1);
        }

        row++;
      };
    })(main);

    addRow(windowWidthPercentageLabel, window_width_percentage);
    addRow(sizeLabel, field_size);
    addRow(cacheDisableLabel, field_cache_disable);
    const modifierSelectors = [];
    let updatingModifiers = false;
    for (const [key, title] of [
      [Fields.QUICK_PASTE_MODIFIERS, _('Modifiers for number-key paste')],
    ]) {
      const selector = new Gtk.ComboBoxText();
      for (let value = 1; value <= 15; value++)
        selector.append(
          String(value),
          format(_('%s+number'), modifierLabel(value)),
        );
      const label = new Gtk.Label({ label: title, xalign: 0, hexpand: true });
      label.set_mnemonic_widget(selector);
      addRow(label, selector);
      modifierSelectors.push([key, selector]);
      selector.connect('changed', () => {
        if (updatingModifiers) return;
        const value = Number(selector.get_active_id());
        settings.set_int(key, value);
      });
    }
    addRow(stripTextLabel, field_strip_text);
    addRow(pasteOnSelectionLabel, field_paste_on_selection);
    addRow(processPrimarySelection, field_process_primary_selection);
    addRow(displayModeLabel, field_display_mode);
    addRow(disableDownArrowLabel, field_disable_down_arrow);
    addRow(topbarPreviewLabel, field_topbar_preview_size);
    addRow(notificationLabel, field_notification_toggle);
    addRow(keybindingLabel, field_keybinding_activation);
    addRow(null, field_keybinding);

    const syncModifiers = () => {
      updatingModifiers = true;
      for (const [key, selector] of modifierSelectors)
        selector.set_active_id(String(settings.get_int(key)));
      updatingModifiers = false;
    };
    syncModifiers();
    const modifierSignals = modifierSelectors.map(([key]) =>
      settings.connect(`changed::${key}`, syncModifiers),
    );
    window.connect('close-request', () => {
      modifierSignals.forEach((id) => settings.disconnect(id));
      return false;
    });

    settings.bind(
      Fields.HISTORY_SIZE,
      field_size,
      'value',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.WINDOW_WIDTH_PERCENTAGE,
      window_width_percentage,
      'value',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.CLEAR_ON_LOGOUT,
      field_cache_disable,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.COPY_FEEDBACK,
      field_notification_toggle,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.TOPBAR_DISPLAY_MODE_ID,
      field_display_mode,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.DISABLE_DOWN_ARROW,
      field_disable_down_arrow,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.TOPBAR_PREVIEW_SIZE,
      field_topbar_preview_size,
      'value',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.STRIP_TEXT,
      field_strip_text,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.PASTE_ON_SELECTION,
      field_paste_on_selection,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.PROCESS_PRIMARY_SELECTION,
      field_process_primary_selection,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      Fields.ENABLE_KEYBINDING,
      field_keybinding_activation,
      'active',
      Gio.SettingsBindFlags.DEFAULT,
    );

    const group = new Adw.PreferencesGroup();
    group.add(main);

    const page = new Adw.PreferencesPage();
    page.add(group);

    window.add(page);
  }

  _create_display_mode_options() {
    const options = [
      { name: _('Icon') },
      { name: _('Clipboard contents') },
      { name: _('Both') },
      { name: _('Neither') },
    ];
    const liststore = new Gtk.ListStore();
    liststore.set_column_types([GObject.TYPE_STRING]);
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const iter = liststore.append();
      liststore.set(iter, [0], [option.name]);
    }
    return liststore;
  }
}

//binding widgets
//////////////////////////////////
const COLUMN_ID = 0;
const COLUMN_DESCRIPTION = 1;
const COLUMN_KEY = 2;
const COLUMN_MODS = 3;

function addKeybinding(model, settings, id, description) {
  // Get the current accelerator.
  const accelerator = settings.get_strv(id)[0];
  let key, mods;
  if (accelerator == null) {
    [key, mods] = [0, 0];
  } else {
    [, key, mods] = Gtk.accelerator_parse(settings.get_strv(id)[0]);
  }

  // Add a row for the keybinding.
  const row = model.insert(100); // Erm...
  model.set(
    row,
    [COLUMN_ID, COLUMN_DESCRIPTION, COLUMN_KEY, COLUMN_MODS],
    [id, description, key, mods],
  );
}

function createKeybindingWidget(Settings) {
  const model = new Gtk.ListStore();

  model.set_column_types([
    GObject.TYPE_STRING, // COLUMN_ID
    GObject.TYPE_STRING, // COLUMN_DESCRIPTION
    GObject.TYPE_INT, // COLUMN_KEY
    GObject.TYPE_INT,
  ]); // COLUMN_MODS

  const treeView = new Gtk.TreeView();
  treeView.model = model;
  treeView.headers_visible = false;

  let column, renderer;

  // Description column.
  renderer = new Gtk.CellRendererText();

  column = new Gtk.TreeViewColumn();
  column.expand = true;
  column.pack_start(renderer, true);
  column.add_attribute(renderer, 'text', COLUMN_DESCRIPTION);

  treeView.append_column(column);

  // Key binding column.
  renderer = new Gtk.CellRendererAccel();
  renderer.accel_mode = Gtk.CellRendererAccelMode.GTK;
  renderer.editable = true;

  renderer.connect(
    'accel-edited',
    function (renderer, path, key, mods, hwCode) {
      const [ok, iter] = model.get_iter_from_string(path);
      if (!ok) {
        return;
      }

      // Update the UI.
      model.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);

      // Update the stored setting.
      const id = model.get_value(iter, COLUMN_ID);
      const accelString = Gtk.accelerator_name(key, mods);
      Settings.set_strv(id, [accelString]);
    },
  );

  renderer.connect('accel-cleared', function (renderer, path) {
    const [ok, iter] = model.get_iter_from_string(path);
    if (!ok) {
      return;
    }

    // Update the UI.
    model.set(iter, [COLUMN_KEY, COLUMN_MODS], [0, 0]);

    // Update the stored setting.
    const id = model.get_value(iter, COLUMN_ID);
    Settings.set_strv(id, []);
  });

  column = new Gtk.TreeViewColumn();
  column.pack_end(renderer, false);
  column.add_attribute(renderer, 'accel-key', COLUMN_KEY);
  column.add_attribute(renderer, 'accel-mods', COLUMN_MODS);

  treeView.append_column(column);

  return treeView;
}
