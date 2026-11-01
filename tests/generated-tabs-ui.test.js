// Run only through the isolated, headless Wayland test runner.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
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
  if (!condition) throw Error(message);
};
const descendants = (actor) => [
  actor,
  ...(actor.get_children?.() || []).flatMap(descendants),
];
const read = (path) =>
  new TextDecoder().decode(GLib.file_get_contents(path)[1]);
export default class extends Extension {
  enable() {
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
      this.timer = null;
      this.check()
        .then(() => this.finish('PASS'))
        .catch((error) => {
          console.error('GENERATED_UI', error);
          this.finish('FAIL');
        });
      return GLib.SOURCE_REMOVE;
    });
  }
  finish(result) {
    this.target?.force_exit();
    GLib.file_set_contents(GLib.get_user_cache_dir() + '/result', result);
  }
  disable() {
    if (this.timer) GLib.Source.remove(this.timer);
    this.target?.force_exit();
  }
  async check() {
    const extension = Main.extensionManager.lookup(
      'paste-board@jidaikobo.shibata',
    );
    const owner = extension.stateObj.clipboardIndicator;
    const { _ } = await import(`file://${extension.path}/i18n.js`);
    const root = GLib.get_user_cache_dir();
    const button = (dialog, label) =>
      descendants(dialog).find(
        (actor) =>
          actor instanceof St.Button &&
          (actor.label === _(label) || actor.accessible_name === _(label)),
      );
    const wait = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await delay(40);
      }
      throw Error('Timed out waiting for UI state');
    };
    const keyboard = Clutter.get_default_backend()
      .get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
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
    owner.settings.set_int('quick-paste-modifiers', 8);
    Main.overview.hide();
    owner.settings.set_boolean('pause-command-previews', false);
    GLib.file_set_contents(root + '/counter', '0');
    const command = `n=$(cat '${root}/counter'); n=$((n+1)); printf '%s' "$n" > '${root}/counter'; sleep .2; if [ "$n" -eq 1 ]; then printf 'alpha\\n beta \\n\\n'; else printf ' beta \\nalpha\\n'; fi`;
    owner._editPasteSetName();
    await delay(200);
    let dialog = owner._pasteSetDialog;
    const name = descendants(dialog).find(
      (actor) =>
        actor instanceof St.Entry && actor.accessible_name === _('Name'),
    );
    const body = descendants(dialog).find(
      (actor) =>
        actor instanceof St.Entry &&
        actor.accessible_name === _('Text to paste'),
    );
    assert(
      !body.mapped && !dialog._editorRun.mapped,
      'Manual tab editor exposes command body',
    );
    name.set_text('Generated sample');
    button(dialog, 'Generate from command').emit('clicked', 0);
    assert(
      body.mapped && dialog._editorRun.mapped,
      'Command tab editor hides command body',
    );
    const mode = dialog._editorModeMenu
      ._getMenuItems()
      .find((item) => item.label.text === _('Bash (one-liner)'));
    mode.activate(null);
    body.set_text(command);
    assert(read(root + '/counter') === '0', 'Editing executed the generator');
    button(dialog, 'Save').emit('clicked', 0);
    await delay(250);
    await owner._pasteSets.flush();
    const set = owner._pasteSets.data.sets.find(
      (set) => set.name === 'Generated sample',
    );
    assert(
      set?.kind === 'generated' && set.executionMode === 'bash',
      'Generated tab configuration was not saved',
    );
    assert(
      set.items.length === 0 && read(root + '/counter') === '0',
      'Save executed or persisted generated items',
    );
    const desktop = GLib.get_user_data_dir() + '/applications';
    GLib.mkdir_with_parents(desktop, 0o700);
    GLib.file_set_contents(
      desktop + '/org.pasteboard.GeneratedTabTest.desktop',
      `[Desktop Entry]\nType=Application\nName=Generated tab test\nExec=gjs -m ${extension.path}/tests/generated-tabs-target.mjs\nStartupWMClass=org.pasteboard.GeneratedTabTest\n`,
    );
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.NONE,
    });
    launcher.setenv(
      'WAYLAND_DISPLAY',
      GLib.getenv('PASTE_BOARD_TEST_DISPLAY'),
      true,
    );
    this.target = launcher.spawnv([
      'gjs',
      '-m',
      extension.path + '/tests/generated-tabs-target.mjs',
    ]);
    await wait(() =>
      global
        .get_window_actors()
        .some(
          (actor) =>
            actor.meta_window.get_title() === 'Generated tab paste target',
        ),
    );
    const target = global
      .get_window_actors()
      .find(
        (actor) =>
          actor.meta_window.get_title() === 'Generated tab paste target',
      ).meta_window;
    await delay(500);
    target.activate(global.get_current_time());
    await delay(500);
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      'original clipboard',
    );
    await delay(200);
    owner.settings.set_boolean('keep-menu-open', true);
    owner._pasteAfterAction = 'none';
    owner.menu.open();
    await delay(200);
    assert(
      owner._activePasteTab === 'history' && read(root + '/counter') === '0',
      'Opening panel executed a generator',
    );
    owner._switchPasteTab(set.id);
    await delay(60);
    assert(
      owner._visiblePasteCandidates().length === 0,
      'Partial generator output became selectable',
    );
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    await delay(100);
    let rows = owner._visiblePasteCandidates();
    assert(
      rows.length === 2 &&
        rows[0].entry.text === 'alpha' &&
        rows[1].entry.text === ' beta ',
      'Generated candidates differ',
    );
    assert(
      rows[0].shortcutLabel.text === '1' && rows[1].shortcutLabel.text === '2',
      'Generated numbering differs',
    );
    assert(
      rows.every(
        (row) =>
          !row.getPasteDragContent &&
          !row._moveButtons.length &&
          !descendants(row).some((actor) => actor instanceof St.Button),
      ),
      'Generated rows are editable',
    );
    rows[0].emit('activate', null);
    await wait(() => !owner._quickPasteBusy);
    await delay(200);
    assert(
      read(root + '/generated-pasted') === 'alpha',
      'Click did not paste generated text',
    );
    rows[1].grab_key_focus();
    await key(Clutter.KEY_Return);
    await wait(() => !owner._quickPasteBusy);
    await delay(150);
    assert(
      read(root + '/generated-pasted') === 'alpha beta ',
      'Enter did not paste generated text',
    );
    owner.settings.set_int('quick-paste-modifiers', 8);
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Super_L,
      Clutter.KeyState.PRESSED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_1,
      Clutter.KeyState.PRESSED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_1,
      Clutter.KeyState.RELEASED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Super_L,
      Clutter.KeyState.RELEASED,
    );
    await delay(300);
    await wait(() => !owner._quickPasteBusy);
    assert(
      read(root + '/generated-pasted') === 'alpha beta alpha',
      'Numeric shortcut did not paste generated candidate',
    );
    const clipboard = await new Promise((resolve) =>
      St.Clipboard.get_default().get_text(
        St.ClipboardType.CLIPBOARD,
        (_c, text) => resolve(text),
      ),
    );
    assert(
      clipboard === 'original clipboard' && read(root + '/counter') === '1',
      'Paste changed clipboard or reran generator',
    );
    rows[0].grab_key_focus();
    owner._refreshGeneratedTab();
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    await delay(100);
    rows = owner._visiblePasteCandidates();
    assert(
      rows[0].entry.text === ' beta ' && rows[1].entry.text === 'alpha',
      'Refresh did not replace snapshot',
    );
    assert(
      global.stage.get_key_focus() === rows[1],
      'Refresh lost matching selection',
    );
    owner.searchEntry.set_text('alp');
    await delay(100);
    owner._refreshGeneratedTab();
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    assert(
      owner.searchEntry.get_text() === 'alp' &&
        owner._visiblePasteCandidates().length === 1,
      'Refresh lost search filter',
    );
    owner.searchEntry.set_text('');
    await delay(100);
    owner.settings.set_boolean('pause-command-previews', true);
    await delay(100);
    assert(
      owner._visiblePasteCandidates().length === 0 &&
        owner._generatedTabs.record?.state === 'idle',
      'Pause retained generated results',
    );
    owner.settings.set_boolean('pause-command-previews', false);
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    owner.settings.set_boolean('pause-command-previews', true);
    await delay(100);
    assert(
      owner._generatedTabs.record?.state === 'idle',
      'Re-pausing did not suppress automatic generation',
    );
    const count = read(root + '/counter');
    owner.menu.close();
    await delay(150);
    owner.menu.open();
    await delay(150);
    owner._switchPasteTab(set.id);
    await delay(300);
    assert(
      read(root + '/counter') === count &&
        owner._visiblePasteCandidates().length === 0,
      'Paused tab executed automatically',
    );
    owner._refreshGeneratedTab();
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    assert(
      owner._visiblePasteCandidates().length === 2,
      'Explicit refresh while paused failed',
    );
    owner.settings.set_boolean('private-mode', true);
    await delay(100);
    assert(
      owner._generatedTabs.record === null,
      'Private mode retained generated output',
    );
    owner._refreshGeneratedTab();
    await delay(100);
    assert(
      read(root + '/counter') === String(Number(count) + 1),
      'Private refresh executed',
    );
    owner.settings.set_boolean('private-mode', false);
    await delay(100);
    owner._switchPasteTab(set.id);
    await delay(100);
    owner._pasteSets.configure(set.id, 'Generated sample', {
      kind: 'generated',
      command: `sleep 2; touch '${root}/cancel-marker'; printf late`,
      executionMode: 'bash',
    });
    owner._renderPasteSets();
    owner._refreshGeneratedTab();
    await delay(100);
    if (owner._generatedTabs.record?.state !== 'pending')
      owner._refreshGeneratedTab();
    await delay(100);
    owner._refreshGeneratedTab();
    assert(
      owner._generatedTabs.record.state === 'stopped',
      'Refresh did not stop pending generation',
    );
    await delay(2100);
    assert(
      !GLib.file_test(root + '/cancel-marker', GLib.FileTest.EXISTS),
      'Stopped generator kept running',
    );
    owner._refreshGeneratedTab();
    await delay(100);
    owner._switchPasteTab('history');
    await delay(2100);
    assert(
      !GLib.file_test(root + '/cancel-marker', GLib.FileTest.EXISTS),
      'Tab switch did not cancel generation',
    );
    owner._pasteSets.configure(set.id, 'Generated sample', {
      kind: 'generated',
      command: "printf 'partial'; exit 1",
      executionMode: 'bash',
    });
    owner._switchPasteTab(set.id);
    owner._refreshGeneratedTab();
    await wait(() => owner._generatedTabs.record?.state === 'error');
    assert(
      owner._visiblePasteCandidates().length === 0,
      'Failed generator published partial output',
    );
    owner._pasteSets.configure(set.id, 'Generated sample', {
      kind: 'generated',
      command: "printf 'alpha\\n beta \\n'",
      executionMode: 'bash',
    });
    owner._switchPasteTab('history');
    owner._switchPasteTab(set.id);
    owner._refreshGeneratedTab();
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    await owner._pasteSets.flush();
    const saved = JSON.parse(read(owner._pasteSets.path)).sets.find(
      (item) => item.id === set.id,
    );
    assert(
      saved.items.length === 0 &&
        !read(owner._pasteSets.path).includes('generated:0'),
      'Generated rows entered persistent data',
    );
    owner._editCurrentPasteTab();
    await delay(200);
    dialog = owner._pasteSetDialog;
    assert(
      button(dialog, 'Generate from command').has_style_pseudo_class('checked'),
      'Tab editor did not restore generated type',
    );
    assert(
      descendants(dialog)
        .filter((actor) => actor.style_class === 'check-box')
        .filter(
          (actor) =>
            actor.accessible_name !== _('Run command during cross-tab search'),
        )
        .every((actor) => !actor.mapped),
      'Item-specific checkboxes leaked into tab editor',
    );
    const autoSearch = button(dialog, 'Run command during cross-tab search');
    assert(
      autoSearch?.mapped && !autoSearch.checked,
      'Search auto-run checkbox is absent or not opt-in',
    );
    autoSearch.checked = true;
    autoSearch.emit('clicked', 0);
    button(dialog, 'Save').emit('clicked', 0);
    await delay(200);
    await owner._pasteSets.flush();
    assert(
      owner._pasteSets.data.sets.find((tab) => tab.id === set.id)
        .runOnSearch === true,
      'Search auto-run option was not saved by editor',
    );
    owner.menu.open();
    await delay(150);
    owner._switchPasteTab(set.id);
    owner._refreshGeneratedTab();
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    if (GLib.getenv('EDITOR_TEST_CAPTURE')) {
      const stream = Gio.File.new_for_path(root + '/generated-tab.png').replace(
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null,
      );
      const screenshot = new Shell.Screenshot();
      await new Promise((resolve, reject) =>
        screenshot.screenshot_area(0, 0, 1280, 800, stream, (o, r) => {
          try {
            o.screenshot_area_finish(r);
            resolve();
          } catch (e) {
            reject(e);
          }
        }),
      );
      stream.close(null);
    }
    owner.menu.close();
    await delay(150);
    assert(
      owner._generatedTabs.record === null,
      'Closing panel retained generator snapshot',
    );
  }
}
