import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const assert = (value, message) => {
  if (!value) throw Error(message);
};
export default class extends Extension {
  enable() {
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
      this.timer = null;
      this.check()
        .then(() => this.finish('PASS'))
        .catch((error) => {
          console.error('SEARCH_UI', error);
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
    const { _ } = await import(`file://${extension.path}/i18n.js`);
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(40);
      }
      throw Error('Tab context UI timed out');
    };
    const descendants = (actor) => [
      actor,
      ...(actor.get_children?.() || []).flatMap(descendants),
    ];
    const button = (root, label) =>
      descendants(root).find(
        (actor) =>
          actor instanceof St.Button &&
          (actor.label === _(label) || actor.accessible_name === _(label)),
      );
    const nameEntry = (dialog) =>
      descendants(dialog).find(
        (actor) =>
          actor instanceof St.Entry && actor.accessible_name === _('Name'),
      );
    const keyboard = Clutter.get_default_backend()
      .get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const pointer = Clutter.get_default_backend()
      .get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const key = async (symbol) => {
      keyboard.notify_keyval(
        GLib.get_monotonic_time(),
        symbol,
        Clutter.KeyState.PRESSED,
      );
      keyboard.notify_keyval(
        GLib.get_monotonic_time(),
        symbol,
        Clutter.KeyState.RELEASED,
      );
      await delay(150);
    };
    const rightClick = async (id) => {
      const tab = owner._pasteTabButtons.get(id);
      const [x, y] = tab.get_transformed_position();
      const [w, h] = tab.get_transformed_size();
      pointer.notify_absolute_motion(
        GLib.get_monotonic_time(),
        x + w / 2,
        y + h / 2,
      );
      await delay(60);
      pointer.notify_button(
        GLib.get_monotonic_time(),
        Clutter.BUTTON_SECONDARY,
        Clutter.ButtonState.PRESSED,
      );
      pointer.notify_button(
        GLib.get_monotonic_time(),
        Clutter.BUTTON_SECONDARY,
        Clutter.ButtonState.RELEASED,
      );
      await wait(() => owner._tabContextMenu?.isOpen);
      await delay(100);
    };
    Main.overview.hide();
    const manual = owner._pasteSets.create('Reusable text');
    owner._pasteSets.put(manual, { name: 'Example', text: 'example' });
    const marker = GLib.get_user_cache_dir() + '/must-not-run';
    const generated = owner._pasteSets.create('Hosts', {
      kind: 'generated',
      executionMode: 'bash',
      command: `touch '${marker}'; printf 'ssh staging'`,
    });
    await owner._pasteSets.flush();
    owner._renderPasteSets();
    owner.menu.open();
    await delay(200);
    await rightClick(generated);
    assert(
      owner.menu.isOpen && owner._activePasteTab === 'history',
      'Right click changed or closed the active tab',
    );
    assert(
      !GLib.file_test(marker, GLib.FileTest.EXISTS),
      'Right click ran a generator',
    );
    assert(
      owner._tabContextMenu._getMenuItems().length === 2,
      'Custom tab does not offer edit and delete',
    );
    await key(Clutter.KEY_Escape);
    assert(
      owner.menu.isOpen && !owner._tabContextMenu.isOpen,
      'Escape did not dismiss only the context menu',
    );
    await rightClick(generated);
    await key(Clutter.KEY_Return);
    await wait(() => owner._pasteSetDialog);
    const edit = owner._pasteSetDialog;
    assert(
      nameEntry(edit).get_text() === 'Hosts',
      'Context edit targeted the active tab instead of clicked tab',
    );
    nameEntry(edit).set_text('SSH hosts');
    button(edit, 'Save').emit('clicked', 0);
    await delay(200);
    assert(
      owner._pasteSets.data.sets.find((set) => set.id === generated).name ===
        'SSH hosts',
      'Context edit was not saved',
    );
    assert(
      owner._activePasteTab === 'history' &&
        !GLib.file_test(marker, GLib.FileTest.EXISTS),
      'Editing activated a generated tab',
    );
    owner.menu.open();
    await delay(150);
    await rightClick(manual);
    await key(Clutter.KEY_Return);
    await wait(() => owner._pasteSetDialog);
    const conversion = owner._pasteSetDialog;
    button(conversion, 'Generate from command').emit('clicked', 0);
    descendants(conversion)
      .find(
        (actor) =>
          actor instanceof St.Entry &&
          actor.accessible_name === _('Command to execute'),
      )
      .set_text('date');
    button(conversion, 'Save').emit('clicked', 0);
    await delay(150);
    const alert = descendants(conversion).find(
      (actor) => actor.style_class === 'ci-editor-error-banner',
    );
    assert(
      alert?.mapped &&
        alert.get_parent() === conversion.contentLayout &&
        global.stage.get_key_focus() === alert,
      'Conversion error is not prominent and focused outside the scroll area',
    );
    assert(
      alert.accessible_name ===
        _('Only an empty paste set can be changed to a command tab.'),
      'Conversion error reason missing',
    );
    assert(
      owner._pasteSets.data.sets.find((set) => set.id === manual).items
        .length === 1,
      'Rejected conversion changed saved items',
    );
    button(conversion, 'Cancel').emit('clicked', 0);
    await delay(150);
    owner.menu.open();
    await delay(150);
    await rightClick(manual);
    owner._tabContextMenu._getMenuItems()[1].activate(null);
    await delay(150);
    assert(
      owner.menu.isOpen &&
        owner._pasteSets.data.sets.some((set) => set.id === manual),
      'Delete bypassed confirmation or closed the panel',
    );
    const modal = Main.layoutManager.modalDialogGroup;
    assert(
      button(modal, 'Cancel') && button(modal, 'Delete'),
      'Delete confirmation did not open',
    );
    button(modal, 'Cancel').emit('clicked', 0);
    await delay(200);
    assert(
      owner._pasteSets.data.sets.some((set) => set.id === manual),
      'Cancel deleted a tab',
    );
    await rightClick(manual);
    owner._tabContextMenu._getMenuItems()[1].activate(null);
    await delay(150);
    button(modal, 'Delete').emit('clicked', 0);
    await delay(200);
    assert(
      !owner._pasteSets.data.sets.some((set) => set.id === manual) &&
        owner._activePasteTab === 'history' &&
        owner.menu.isOpen,
      'Confirmed delete affected wrong tab or closed panel',
    );
    await rightClick('history');
    assert(
      owner._tabContextMenu._getMenuItems().length === 1,
      'History offers deletion',
    );
    await key(Clutter.KEY_Return);
    await wait(() => owner._pasteSetDialog);
    assert(
      nameEntry(owner._pasteSetDialog).get_text() === _('History'),
      'History context edit unavailable',
    );
    button(owner._pasteSetDialog, 'Cancel').emit('clicked', 0);
    await delay(150);
    owner.menu.open();
    await delay(150);
    const footer = button(owner._footerActions, 'Edit the current tab');
    assert(
      footer?.can_focus && footer.reactive,
      'Accessible footer edit was removed',
    );
    footer.emit('clicked', 0);
    await wait(() => owner._pasteSetDialog);
    button(owner._pasteSetDialog, 'Cancel').emit('clicked', 0);
    await delay(100);
    owner.menu.open();
    await delay(150);
    await rightClick('history');
    owner.menu.close();
    assert(
      !owner._tabContextMenu?.isOpen,
      'Panel close left context menu open',
    );
    assert(
      !GLib.file_test(marker, GLib.FileTest.EXISTS),
      'Tab context actions executed a command',
    );
    owner.menu.open();
    await delay(150);
    await rightClick('history');
    owner._pasteSets.renameHistory('Clipboard');
    owner._renderPasteSets();
    await delay(100);
    assert(
      !owner._tabContextMenu && owner._tabContextManager._menus.length === 0,
      'Rebuilt tabs leaked their context popup',
    );
    await rightClick('history');
    owner.menu.close();
  }
}
