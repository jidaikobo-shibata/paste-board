// Loaded only by run-editor-ui-test.sh in an isolated, headless Shell.
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Atk from 'gi://Atk';
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
        (actor) =>
          actor instanceof St.Button &&
          (actor.label === _(label) || actor.accessible_name === _(label)),
      );
    const capture = async (name) => {
      if (!GLib.getenv('EDITOR_TEST_CAPTURE')) return;
      const { default: Gio } = await import('gi://Gio');
      const { default: Shell } = await import('gi://Shell');
      const stream = Gio.File.new_for_path(
        `${GLib.get_user_cache_dir()}/${name}.png`,
      ).replace(null, false, Gio.FileCreateFlags.NONE, null);
      const screenshot = new Shell.Screenshot();
      await new Promise((resolve, reject) =>
        screenshot.screenshot_area(
          0,
          0,
          global.stage.width,
          global.stage.height,
          stream,
          (object, result) => {
            try {
              object.screenshot_area_finish(result);
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        ),
      );
      stream.close(null);
    };
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
    assert(
      descendants(dialog).some(
        (actor) =>
          actor instanceof St.Label && actor.text === _('Name') && actor.mapped,
      ),
      'Name label is not persistent',
    );
    const title = descendants(dialog).find(
      (actor) =>
        actor instanceof St.Label &&
        actor.has_style_class_name('ci-editor-title'),
    );
    assert(
      title?.get_parent() === dialog.contentLayout,
      'Title is inside scrolling content',
    );
    assert(
      descendants(dialog).some(
        (actor) => actor instanceof St.Label && actor.text === _('Body'),
      ),
      'Text body label differs',
    );
    await capture('editor-text');
    button(dialog, 'Text').grab_key_focus();
    await key(Clutter.KEY_Right);
    assert(dialog._editorRun.mapped, 'Right arrow did not change editing tab');
    await key(Clutter.KEY_Left);
    assert(!dialog._editorRun.mapped, 'Left arrow did not restore text tab');
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
    await capture('editor-command');
    const help = button(dialog, 'About command execution');
    const explanation = descendants(dialog).find(
      (actor) =>
        actor instanceof St.Label &&
        actor.text.includes(
          _(
            'Commands requiring interactive input, such as password prompts, are not supported.',
          ),
        ),
    );
    assert(!explanation.mapped, 'Command details are not initially collapsed');
    help.grab_key_focus();
    await key(Clutter.KEY_space);
    assert(
      explanation.mapped &&
        help
          .get_accessible()
          .ref_state_set()
          .contains_state(Atk.StateType.EXPANDED),
      'Keyboard help did not expose details and expanded state',
    );
    await capture('editor-help');
    await key(Clutter.KEY_space);
    assert(
      !explanation.mapped && !dialog._editorPreviewRun,
      'Help ran a command or did not collapse',
    );
    const checks = descendants(dialog).filter(
      (actor) => actor.accessible_role === Atk.Role.CHECK_BOX,
    );
    assert(checks.length === 2, 'Command options are not standard checkboxes');
    checks[0].grab_key_focus();
    await key(Clutter.KEY_space);
    assert(checks[0].checked, 'Space did not enable checkbox');
    await key(Clutter.KEY_space);
    assert(!checks[0].checked, 'Space did not disable checkbox');
    const select = descendants(dialog).find(
      (actor) => actor.accessible_role === Atk.Role.COMBO_BOX,
    );
    select.grab_key_focus();
    await key(Clutter.KEY_space);
    assert(
      dialog._editorModeMenu.isOpen,
      'Keyboard did not open mode dropdown',
    );
    await key(Clutter.KEY_Escape);
    assert(
      !dialog._editorModeMenu.isOpen && !dialog._editorPreviewClosed,
      'Escape closed the editor instead of dropdown',
    );
    select.grab_key_focus();
    await key(Clutter.KEY_Down);
    await key(Clutter.KEY_Down);
    await key(Clutter.KEY_Return);
    assert(
      !dialog._editorModeMenu.isOpen &&
        select.accessible_name.includes(_('Bash (one-liner)')),
      'Keyboard did not select Bash mode',
    );
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
    const commandInput = descendants(dialog).find(
      (actor) =>
        actor instanceof St.Entry &&
        actor.accessible_name === _('Command to execute'),
    );
    commandInput.set_text('printf "%s\\n" "$((1+1))"');
    button(dialog, 'Run and preview').emit('clicked', 0);
    for (let attempt = 0; attempt < 100 && dialog._editorPreviewRun; attempt++)
      await delay(50);
    assert(
      dialog._editorOutput.get_text() === '2\n',
      'Selected Bash execution mode was not used',
    );
    checks[1].grab_key_focus();
    await key(Clutter.KEY_space);
    assert(checks[1].checked, 'Automatic preview checkbox did not toggle');
    button(dialog, 'Save').emit('clicked', 0);
    await delay(200);
    await owner._pasteSets.flush();
    const saved = owner._pasteSets.data.sets[0].items[1];
    assert(
      saved.executionMode === 'bash' &&
        saved.previewOnOpen &&
        !saved.trimTrailingNewlines,
      'Save lost selected execution settings',
    );
    const modalCount = Main.modalCount;
    owner._editPasteSetItem(id, saved);
    await delay(200);
    dialog = owner._pasteSetDialog;
    const reopenedSelect = descendants(dialog).find(
      (actor) => actor.accessible_role === Atk.Role.COMBO_BOX,
    );
    reopenedSelect.grab_key_focus();
    await key(Clutter.KEY_space);
    assert(dialog._editorModeMenu.isOpen, 'Reopened dropdown did not open');
    dialog.close();
    await delay(250);
    assert(
      Main.modalCount === modalCount,
      'Closing editor left a modal input grab',
    );
  }
}
