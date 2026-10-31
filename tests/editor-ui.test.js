// Loaded only by run-editor-ui-test.sh in an isolated, headless Shell.
import GLib from 'gi://GLib';
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const descendants = (actor) => [
  actor,
  ...(actor.get_children?.() || []).flatMap(descendants),
];

export default class extends Extension {
  enable() {
    this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
      this._timer = null;
      this.check().then(
        () => this.finish('PASS'),
        (error) => {
          console.error('EDITOR_UI_TEST', error);
          this.finish('FAIL');
        },
      );
      return GLib.SOURCE_REMOVE;
    });
  }

  finish(result) {
    GLib.file_set_contents(`${GLib.get_user_cache_dir()}/result`, result);
  }

  disable() {
    if (this._timer) GLib.Source.remove(this._timer);
  }

  async check() {
    const extension = Main.extensionManager.lookup(
      'paste-board@jidaikobo.shibata',
    );
    const owner = extension.stateObj.clipboardIndicator;
    const { _ } = await import(`file://${extension.path}/i18n.js`);
    const seat = Clutter.get_default_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(
      Clutter.InputDeviceType.KEYBOARD_DEVICE,
    );
    const pointer = seat.create_virtual_device(
      Clutter.InputDeviceType.POINTER_DEVICE,
    );
    const key = async (keyval) => {
      keyboard.notify_keyval(
        GLib.get_monotonic_time(),
        keyval,
        Clutter.KeyState.PRESSED,
      );
      keyboard.notify_keyval(
        GLib.get_monotonic_time(),
        keyval,
        Clutter.KeyState.RELEASED,
      );
      await delay(150);
    };
    const button = (dialog, label) =>
      descendants(dialog).find(
        (actor) => actor instanceof St.Button && actor.label === _(label),
      );
    Main.overview.hide();
    const id = owner._pasteSets.create('Editor test');
    owner._pasteSets.put(id, {
      name: 'Test text',
      kind: 'text',
      text: 'short',
    });
    let item = owner._pasteSets.data.sets[0].items[0];
    owner._editPasteSetItem(id, item);
    await delay(200);
    let dialog = owner._pasteSetDialog;
    assert(!dialog._editorRun.mapped, 'Text editor displays command controls');
    assert(!dialog._editorOutput.mapped, 'Text editor displays command output');
    const body = descendants(dialog).find(
      (actor) =>
        actor instanceof St.Entry &&
        actor.accessible_name === _('Text to paste'),
    );
    const [x, y] = body.get_transformed_position();
    const [width, height] = body.get_transformed_size();
    pointer.notify_absolute_motion(
      GLib.get_monotonic_time(),
      x + width / 2,
      y + height / 2,
    );
    await delay(100);
    pointer.notify_button(
      GLib.get_monotonic_time(),
      Clutter.BUTTON_PRIMARY,
      Clutter.ButtonState.PRESSED,
    );
    pointer.notify_button(
      GLib.get_monotonic_time(),
      Clutter.BUTTON_PRIMARY,
      Clutter.ButtonState.RELEASED,
    );
    await delay(100);
    assert(
      global.stage.get_key_focus() === body.clutter_text,
      'Empty body area did not focus input',
    );
    body.clutter_text.set_selection(-1, -1);
    await key(Clutter.KEY_x);
    assert(body.get_text() === 'shortx', 'Real keyboard input failed');
    const longText = Array.from(
      { length: 80 },
      (_, index) => `line-${index}`,
    ).join('\n');
    body.set_text(longText);
    body.clutter_text.set_selection(-1, -1);
    await delay(250);
    const scroll = body.get_parent().get_parent();
    assert(
      scroll.vadjustment.upper > scroll.vadjustment.page_size,
      'Long body has no scroll range',
    );
    assert(scroll.vadjustment.value > 0, 'Cursor did not scroll to the end');
    await key(Clutter.KEY_Return);
    assert(
      body.get_text() === `${longText}\n`,
      'Enter did not insert a newline',
    );
    const [valid, , cursorY, cursorHeight] =
      body.clutter_text.position_to_coords(-1);
    const top = body.clutter_text.y + cursorY;
    assert(
      valid &&
        top >= scroll.vadjustment.value - 1 &&
        top + cursorHeight <=
          scroll.vadjustment.value + scroll.vadjustment.page_size + 1,
      'End cursor is outside the visible body',
    );
    body.clutter_text.set_selection(0, 0);
    await delay(150);
    assert(
      scroll.vadjustment.value < 20,
      'Cursor did not scroll back to the start',
    );
    button(dialog, 'Command').emit('clicked', 0);
    await delay(100);
    assert(dialog._editorRun.mapped, 'Command controls did not appear');
    button(dialog, 'Text').emit('clicked', 0);
    await delay(100);
    assert(!dialog._editorRun.mapped, 'Command controls did not disappear');
    button(dialog, 'Save').emit('clicked', 0);
    await delay(200);
    await owner._pasteSets.flush();
    item = owner._pasteSets.data.sets[0].items[0];
    assert(item.text === `${longText}\n`, 'Save changed multiline text');
    owner._editPasteSetItem(id, item);
    await delay(200);
    dialog = owner._pasteSetDialog;
    assert(
      !dialog._editorRun.mapped,
      'Reopened text editor displays command controls',
    );
    dialog.close();
    await delay(200);
    owner._pasteSets.put(id, {
      name: 'Test command',
      kind: 'command',
      text: '',
      command: 'python3 -c \'print("preview\\n" * 80)\'',
      executionMode: 'direct',
      trimTrailingNewlines: false,
      previewOnOpen: false,
    });
    item = owner._pasteSets.data.sets[0].items[1];
    owner._editPasteSetItem(id, item);
    await delay(200);
    dialog = owner._pasteSetDialog;
    assert(
      dialog._editorRun.mapped,
      'Opened command editor hides command controls',
    );
    assert(!dialog._editorPreviewRun, 'Opening editor executed command');
    button(dialog, 'Run and preview').emit('clicked', 0);
    for (let attempt = 0; attempt < 100 && dialog._editorPreviewRun; attempt++)
      await delay(50);
    await delay(150);
    assert(
      dialog._editorOutput.get_text() === `${'preview\n'.repeat(80)}\n`,
      'Preview output differs',
    );
    const outputScroll = dialog._editorOutput.get_parent().get_parent();
    assert(
      outputScroll.vadjustment.upper > outputScroll.vadjustment.page_size,
      'Long output has no scroll range',
    );
    assert(!dialog._editorOutput.clutter_text.editable, 'Output is editable');
    dialog.close();
  }
}
