import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(0, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const actors = (actor) => [
  actor,
  ...(actor.get_children?.() || []).flatMap(actors),
];
const assert = (value, message) => {
  if (!value) throw Error(message);
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
    const { _ } = await import(`file://${extension.path}/i18n.js`);
    const button = (root, label) =>
      actors(root).find(
        (a) =>
          a instanceof St.Button &&
          (a.accessible_name === _(label) || a.label === _(label)),
      );
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(40);
      }
      throw Error('Management test timed out');
    };
    Main.overview.hide();
    const root = GLib.get_user_cache_dir();
    const manual = owner._pasteSets.create('Fixture manual');
    owner._pasteSets.put(manual, {
      name: 'fixture first',
      text: 'fixture first text',
    });
    owner._pasteSets.put(manual, {
      name: 'fixture second',
      text: 'fixture second text',
    });
    owner._pasteSets.put(manual, {
      name: 'fixture command',
      kind: 'command',
      command: `touch '${root}/must-not-run'`,
      executionMode: 'bash',
      previewOnOpen: true,
    });
    owner._pasteSets.create('Fixture generated', {
      kind: 'generated',
      command: `touch '${root}/must-not-run'; printf fixture`,
      executionMode: 'bash',
    });
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      'fixture history',
    );
    await wait(() => owner.entries.last()?.text === 'fixture history');
    owner._renderPasteSets();
    owner.menu.open();
    await delay(150);
    owner.searchEntry.set_text('fixture');
    await delay(150);
    let rows = owner._visiblePasteCandidates();
    const first = rows.find((row) => row.entry.name === 'fixture first');
    assert(
      button(first, 'Edit name and content') && button(first, 'Delete item'),
      'Search actions missing',
    );
    const keyboard = Clutter.get_default_backend()
      .get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    button(first, 'Edit name and content').grab_key_focus();
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Return,
      Clutter.KeyState.PRESSED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Return,
      Clutter.KeyState.RELEASED,
    );
    await wait(() => owner._pasteSetDialog);
    const dialog = owner._pasteSetDialog;
    assert(
      owner.menu.isOpen && owner.searchEntry.get_text() === 'fixture',
      'Edit lost panel or query',
    );
    const body = actors(dialog).find(
      (a) => a instanceof St.Entry && a.accessible_name === _('Text to paste'),
    );
    body.set_text('updated body');
    actors(dialog)
      .find((a) => a instanceof St.Entry && a.accessible_name === _('Name'))
      .set_text('renamed item');
    button(dialog, 'Save').emit('clicked', 0);
    await delay(250);
    assert(
      owner._pasteSets.data.sets[0].items[0].text === 'updated body',
      'Search edit did not persist',
    );
    rows = owner._visiblePasteCandidates();
    assert(
      !rows.some((row) => row.entry.name === 'renamed item'),
      'Edited item still matches search',
    );
    const second = rows.find((row) => row.entry.name === 'fixture second');
    const editFocus = global.stage.get_key_focus();
    assert(
      editFocus === second || second.contains(editFocus),
      'Edit did not restore focus to the nearest surviving candidate',
    );
    rows[0].grab_key_focus();
    button(second, 'Edit name and content').emit('clicked', 0);
    await wait(() => owner._pasteSetDialog);
    button(owner._pasteSetDialog, 'Save').emit('clicked', 0);
    await delay(250);
    const retained = owner
      ._visiblePasteCandidates()
      .find((row) => row.entry.id === second.entry.id);
    const retainedFocus = global.stage.get_key_focus();
    assert(
      retained === retainedFocus || retained.contains(retainedFocus),
      'Edit restored the previously focused row instead of its explicit target',
    );
    button(retained, 'Delete item').emit('clicked', 0);
    await delay(150);
    assert(
      owner.menu.isOpen && owner.searchEntry.get_text() === 'fixture',
      'Delete lost panel or query',
    );
    button(Main.layoutManager.modalDialogGroup, 'Delete').emit('clicked', 0);
    await delay(250);
    assert(
      owner._pasteSets.data.sets[0].items.length === 2,
      'Search deletion failed',
    );
    const history = owner
      ._visiblePasteCandidates()
      .find((row) => !row.entry.pasteSetItem);
    assert(
      button(history, 'Add to a paste set') &&
        button(history, 'Delete from history'),
      'History actions missing',
    );
    history.grab_key_focus();
    button(history, 'Delete from history').emit('clicked', 0);
    await delay(150);
    assert(
      !owner._visiblePasteCandidates().some((row) => !row.entry.pasteSetItem),
      'History search deletion failed',
    );
    assert(
      owner.menu.isOpen && owner.searchEntry.get_text() === 'fixture',
      'History deletion lost search',
    );
    const focus = global.stage.get_key_focus();
    assert(
      owner
        ._visiblePasteCandidates()
        .some((row) => row === focus || row.contains(focus)),
      'Deletion lost candidate focus',
    );
    owner.menu.close();
    await owner._pasteSets.flush();
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.NONE,
    });
    launcher.setenv(
      'WAYLAND_DISPLAY',
      GLib.getenv('PASTE_BOARD_TEST_DISPLAY'),
      true,
    );
    launcher.setenv('PASTE_BOARD_TEST_REPO', extension.path, true);
    this.target = launcher.spawnv([
      'gjs',
      '-m',
      extension.path + '/tests/backup-prefs-target.mjs',
    ]);
    await wait(() =>
      GLib.file_test(root + '/backup-prefs-result', GLib.FileTest.EXISTS),
    );
    assert(
      new TextDecoder().decode(
        GLib.file_get_contents(root + '/backup-prefs-result')[1],
      ) === 'PASS',
      'Preferences transfer failed',
    );
    const imported = owner._pasteSets.data.sets[3];
    owner.menu.open();
    await delay(100);
    owner._switchPasteTab(imported.id);
    await delay(200);
    assert(
      !GLib.file_test(root + '/must-not-run', GLib.FileTest.EXISTS),
      'Import executed a command',
    );
    assert(
      owner._generatedTabs.get(imported)?.state === 'idle',
      'Imported generator ran on opening',
    );
    owner.menu.close();
  }
}
