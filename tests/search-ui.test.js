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
const assert = (value, message) => {
  if (!value) throw Error(message);
};
const read = (path) =>
  new TextDecoder().decode(GLib.file_get_contents(path)[1]);
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
    const root = GLib.get_user_cache_dir();
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(40);
      }
      throw Error('Timed out waiting for search UI');
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
    const query = async (text) => {
      owner.searchEntry.set_text(text);
      await delay(120);
    };
    const rows = () => owner._visiblePasteCandidates();
    const clipboard = () =>
      new Promise((resolve) =>
        St.Clipboard.get_default().get_text(
          St.ClipboardType.CLIPBOARD,
          (_c, text) => resolve(text),
        ),
      );
    Main.overview.hide();
    owner.settings.set_boolean('pause-command-previews', false);
    owner.settings.set_boolean('keep-menu-open', true);
    owner._pasteAfterAction = 'none';
    assert(
      owner.settings.get_boolean('search-all-tabs') &&
        owner._allTabsCheck.checked,
      'All-tabs search is not enabled by default',
    );
    GLib.file_set_contents(root + '/generator-count', '0');
    GLib.file_set_contents(root + '/command-count', '0');
    const manual = owner._pasteSets.create('Services');
    owner._pasteSets.put(manual, { name: 'prod', text: 'server manual' });
    owner._pasteSets.put(manual, { name: 'dev', text: 'server development' });
    const commands = owner._pasteSets.create('Commands');
    owner._pasteSets.put(commands, {
      name: 'prod server command',
      kind: 'command',
      text: '',
      command: `printf '1' > '${root}/command-count'; printf 'command chosen'`,
      executionMode: 'bash',
      trimTrailingNewlines: true,
      previewOnOpen: true,
    });
    const generated = owner._pasteSets.create('Hosts', {
      kind: 'generated',
      command: `n=$(cat '${root}/generator-count'); printf '%s' "$((n+1))" > '${root}/generator-count'; printf 'prod server generated\\ndev server generated\\n'`,
      executionMode: 'bash',
    });
    const unopened = owner._pasteSets.create('Unopened', {
      kind: 'generated',
      command: `touch '${root}/must-not-run'; printf 'prod server hidden'`,
      executionMode: 'bash',
    });
    await owner._pasteSets.flush();
    owner._renderPasteSets();
    const apps = GLib.get_user_data_dir() + '/applications';
    GLib.mkdir_with_parents(apps, 0o700);
    GLib.file_set_contents(
      apps + '/org.pasteboard.GeneratedTabTest.desktop',
      `[Desktop Entry]\nType=Application\nName=Search test\nExec=gjs -m ${extension.path}/tests/generated-tabs-target.mjs\nStartupWMClass=org.pasteboard.GeneratedTabTest\n`,
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
      'prod server history',
    );
    await delay(200);
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      'original clipboard',
    );
    await delay(200);
    owner.menu.open();
    await delay(200);
    await query('server prod');
    assert(
      rows().length === 3,
      'Global search did not combine history and manual sets',
    );
    assert(
      read(root + '/generator-count') === '0' &&
        read(root + '/command-count') === '0' &&
        !GLib.file_test(root + '/must-not-run', GLib.FileTest.EXISTS),
      'Searching executed a command',
    );
    const notices = () =>
      owner._searchResultsSection
        ._getMenuItems()
        .filter((row) => row.label && !row.entry)
        .map((row) => row.label.text);
    assert(
      notices().some((text) => text.includes('Hosts')) &&
        notices().some((text) => text.includes('Unopened')),
      'Missing generated sources are not explained',
    );
    await query('');
    owner._switchPasteTab(generated);
    await wait(() => owner._generatedTabs.record?.state === 'ready');
    owner._switchPasteTab('history');
    await query('PrOd   SeRvEr');
    assert(rows().length === 4, 'Cached generated results were not included');
    assert(
      rows()
        .map((row) => row.shortcutLabel.text)
        .join(',') === '1,2,3,4',
      'Group headings consumed candidate numbers',
    );
    assert(
      rows()
        .map((row) =>
          row.entry.pasteSetItem ? row.entry.sourceSetId : 'history',
        )
        .join(',') === ['history', manual, commands, generated].join(','),
      'Search groups have wrong order',
    );
    assert(
      rows().every(
        (row) =>
          row.searchGroupName &&
          row.accessible_name.includes(row.searchGroupName),
      ),
      'Search result accessible names omit their source tabs',
    );
    assert(
      read(root + '/generator-count') === '1' &&
        read(root + '/command-count') === '0',
      'Query changes reran a command',
    );
    const ctrlF = async () => {
      keyboard.notify_keyval(
        GLib.get_monotonic_time(),
        Clutter.KEY_Control_L,
        Clutter.KeyState.PRESSED,
      );
      await key(Clutter.KEY_f);
      keyboard.notify_keyval(
        GLib.get_monotonic_time(),
        Clutter.KEY_Control_L,
        Clutter.KeyState.RELEASED,
      );
      await delay(100);
    };
    owner.settings.set_boolean('keep-menu-open', false);
    rows()
      .find((row) => row.entry.sourceSetId === manual)
      .grab_key_focus();
    await ctrlF();
    assert(
      owner.menu.isOpen && owner._isSearchActor(global.stage.get_key_focus()),
      'Ctrl+F did not focus search in an unpinned panel',
    );
    assert(
      owner.searchEntry.get_text() === 'PrOd   SeRvEr',
      'Ctrl+F changed the query',
    );
    await query('prod server');
    await ctrlF();
    assert(
      global.stage.get_key_focus() ===
        rows().find((row) => row.entry.sourceSetId === manual),
      'Ctrl+F did not restore a rebuilt result',
    );
    await ctrlF();
    await query('history');
    await ctrlF();
    assert(
      global.stage.get_key_focus() === rows()[0],
      'Ctrl+F did not fall back to the first result',
    );
    await ctrlF();
    await query('no results xyz');
    await ctrlF();
    assert(
      owner._isSearchActor(global.stage.get_key_focus()),
      'Ctrl+F left search without candidates',
    );
    assert(owner._allTabsCheck.checked, 'Ctrl+F changed the search scope');
    owner.settings.set_boolean('keep-menu-open', true);
    owner._pasteAfterAction = 'none';
    await query('server missing');
    assert(rows().length === 0, 'AND query accepted a partial match');
    await query('server prod');
    const manualRow = rows().find((row) => row.entry.sourceSetId === manual);
    manualRow.grab_key_focus();
    await key(Clutter.KEY_Return);
    await wait(() => !owner._quickPasteBusy);
    await delay(150);
    assert(
      read(root + '/generated-pasted') === 'server manual',
      'Enter did not paste manual search result',
    );
    owner.settings.set_int('quick-paste-modifiers', 8);
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Super_L,
      Clutter.KeyState.PRESSED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_4,
      Clutter.KeyState.PRESSED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_4,
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
      read(root + '/generated-pasted') === 'server manualprod server generated',
      'Numeric shortcut did not paste global generated result',
    );
    const commandRow = rows().find((row) => row.entry.sourceSetId === commands);
    commandRow.emit('activate', null);
    await wait(() => !owner._quickPasteBusy);
    await delay(150);
    assert(
      read(root + '/command-count') === '1' &&
        read(root + '/generated-pasted').endsWith('command chosen'),
      'Explicit command result selection failed',
    );
    assert(
      (await clipboard()) === 'original clipboard',
      'Pinned search paste changed clipboard',
    );
    assert(
      read(root + '/generator-count') === '1' &&
        !GLib.file_test(root + '/must-not-run', GLib.FileTest.EXISTS),
      'Search paste reran a generator',
    );
    owner._allTabsCheck.grab_key_focus();
    await key(Clutter.KEY_space);
    assert(
      !owner._allTabsCheck.checked &&
        rows().length === 1 &&
        !rows()[0].entry.pasteSetItem,
      'Current-tab search did not restrict history',
    );
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      'unrelated newest copy',
    );
    await delay(200);
    assert(
      rows().length === 1 && rows()[0].entry.text === 'prod server history',
      'New clipboard copy bypassed the current-tab search filter',
    );
    owner._allTabsCheck.grab_key_focus();
    await key(Clutter.KEY_space);
    assert(
      owner._allTabsCheck.checked && rows().length === 4,
      'All-tabs toggle did not restore results',
    );
    owner._switchPasteTab(manual);
    owner._allTabsCheck.grab_key_focus();
    await key(Clutter.KEY_space);
    await query('server prod');
    assert(
      rows().length === 1 && rows()[0].entry.name === 'prod',
      'Current-tab AND search did not match across name and text',
    );
    owner._allTabsCheck.grab_key_focus();
    await key(Clutter.KEY_space);
    await query(' \t　');
    assert(
      !owner._isCrossTabSearch() && rows().length === 2,
      'Whitespace query did not show current tab normally',
    );
    owner._switchPasteTab('history');
    await query('server prod');
    if (GLib.getenv('EDITOR_TEST_CAPTURE')) {
      const stream = Gio.File.new_for_path(
        root + '/all-tab-search.png',
      ).replace(null, false, Gio.FileCreateFlags.NONE, null);
      const shot = new Shell.Screenshot();
      await new Promise((resolve, reject) =>
        shot.screenshot_area(0, 0, 1280, 800, stream, (o, r) => {
          try {
            o.screenshot_area_finish(r);
            resolve();
          } catch (error) {
            reject(error);
          }
        }),
      );
      stream.close(null);
    }
    const many = owner._pasteSets.create('Many');
    for (let i = 0; i < 65; i++)
      owner._pasteSets.put(many, {
        name: `Item ${i}`,
        text: `pagination match ${i}`,
      });
    await owner._pasteSets.flush();
    await query('pagination match');
    assert(
      rows().length === 50 && owner._crossSearchHasMore,
      'Global search did not bound the first page',
    );
    owner._navigateNextPage();
    assert(
      rows().length === 15 &&
        rows()[0].entry.text === 'pagination match 50' &&
        !owner._crossSearchHasMore,
      'Global next page is wrong',
    );
    assert(
      rows()[0].shortcutLabel.text === '1',
      'Next-page numbering did not restart',
    );
    owner._navigatePrevPage();
    assert(
      rows().length === 50 && rows()[0].entry.text === 'pagination match 0',
      'Global previous page is wrong',
    );
    owner.searchEntry.grab_key_focus();
    owner._focusNextMenuControl(false);
    assert(
      global.stage.get_key_focus() === owner._allTabsCheck,
      'Tab order skipped search scope checkbox',
    );
    owner.settings.set_boolean('private-mode', true);
    await delay(100);
    assert(
      rows().length === 0 &&
        owner._searchResultsSection._getMenuItems().length === 0,
      'Private mode retained global results',
    );
    owner.settings.set_boolean('private-mode', false);
    await delay(150);
    assert(
      rows().length === 50 && read(root + '/generator-count') === '1',
      'Leaving private mode executed a generator or lost search',
    );
    await query('server prod');
    assert(
      rows().length === 3,
      'Private transition did not discard generated cache',
    );
    owner.settings.set_boolean('keep-menu-open', false);
    const historyRow = rows().find((row) => !row.entry.pasteSetItem);
    historyRow.emit('activate', null);
    await wait(() => !owner._quickPasteBusy);
    await delay(150);
    assert(
      !owner.menu.isOpen &&
        (await clipboard()) === 'prod server history' &&
        owner.entries.last().text === 'prod server history',
      'Unpinned history search selection did not commit clipboard',
    );
    assert(
      owner._generatedTabs.records.size === 0 &&
        owner._searchResultsSection._getMenuItems().length === 0,
      'Panel close retained search or generated results',
    );
    owner.menu.open();
    await delay(150);
    assert(
      owner._activePasteTab === 'history' && !owner.searchEntry.get_text(),
      'Reopening did not restore ordinary history',
    );
    assert(
      owner.settings.get_boolean('search-all-tabs') &&
        owner._allTabsCheck.checked,
      'Scope setting was not retained',
    );
    owner._pasteSets.configure(unopened, 'Auto search', {
      kind: 'generated',
      executionMode: 'bash',
      runOnSearch: true,
      command: `n=$(cat '${root}/generator-count'); printf '%s' "$((n+1))" > '${root}/generator-count'; printf 'auto search candidate'`,
    });
    await query('auto search');
    await wait(() =>
      rows().some((row) => row.entry.text === 'auto search candidate'),
    );
    assert(
      read(root + '/generator-count') === '2',
      'Opted-in tab was not executed on search',
    );
    await query('auto search candidate');
    assert(
      read(root + '/generator-count') === '2',
      'Typing reran the search command',
    );
    await query('');
    await query('auto search');
    await wait(() => read(root + '/generator-count') === '3');
    await query('');
    owner.settings.set_boolean('pause-command-previews', true);
    await query('auto search');
    await delay(150);
    assert(
      read(root + '/generator-count') === '3',
      'Pause did not suppress search commands',
    );
    await query('');
    owner.settings.set_boolean('pause-command-previews', false);
    owner.settings.set_boolean('search-all-tabs', false);
    await query('auto search');
    await delay(150);
    assert(
      read(root + '/generator-count') === '3',
      'Current-tab search ran commands',
    );
    await query('');
    owner.settings.set_boolean('search-all-tabs', true);
    const delayed = owner._pasteSets.create('Delayed audit regression', {
      kind: 'generated',
      executionMode: 'bash',
      runOnSearch: true,
      command: "sleep .5; printf 'server audit candidate'",
    });
    const tab = () =>
      owner._pasteSets.data.sets.find((set) => set.id === delayed);
    const record = () => owner._generatedTabs.get(tab());
    await query('server');
    await wait(() => record()?.state === 'pending');
    assert(
      notices().some((text) =>
        text.includes(_('Generating candidates: %s').replace('%s', tab().name)),
      ),
      'Running generation is not explained',
    );
    const before = rows().find((row) => row.entry.sourceSetId === manual);
    before.grab_key_focus();
    await wait(() => record()?.state === 'ready');
    const restored = rows().find((row) => row.entry.sourceSetId === manual);
    assert(
      restored !== before && global.stage.get_key_focus() === restored,
      'Generated results lost the focused candidate',
    );
    await key(Clutter.KEY_Down);
    assert(
      rows().includes(global.stage.get_key_focus()),
      'Navigation failed after generated results arrived',
    );
    await query('');
    await query('server');
    const pasteCandidate = rows().find(
      (row) => row.entry.sourceSetId === manual,
    );
    owner._quickPasteFocusedCandidate = pasteCandidate;
    owner.searchEntry.clutter_text.grab_key_focus();
    owner._quickPasteBusy = true;
    await wait(() => record()?.state === 'ready');
    assert(
      owner._pendingGeneratedRender &&
        !rows().some((row) => row.entry.text === 'server audit candidate'),
      'Generation did not defer while pasting',
    );
    owner._endQuickPasteTracking();
    assert(
      rows().some((row) => row.entry.text === 'server audit candidate') &&
        !owner._pendingGeneratedRender,
      'Paste completion did not flush generated results',
    );
    assert(
      owner._quickPasteFocusedCandidate !== pasteCandidate &&
        owner._quickPasteFocusedCandidate ===
          rows().find((row) => row.entry.sourceSetId === manual),
      'Deferred update lost the paste return candidate',
    );
    assert(
      owner._isSearchActor(global.stage.get_key_focus()),
      'Deferred update stole search focus',
    );
    owner._quickPasteFocusedCandidate = undefined;
    await query('');
    owner._pasteSets.configure(delayed, tab().name, {
      kind: 'generated',
      executionMode: 'bash',
      runOnSearch: true,
      command: "printf 'audit failure reason' >&2; exit 1",
    });
    await query('audit');
    await wait(() => record()?.state === 'error');
    assert(
      notices().some(
        (text) =>
          text.includes(tab().name) &&
          text.includes(_('The command did not exit successfully.')),
      ),
      'Failed generation did not expose its reason',
    );
    await query('');
    await query('audit');
    owner._quickPasteBusy = true;
    await wait(() => record()?.state === 'error');
    owner.menu.close();
    owner._endQuickPasteTracking();
    assert(
      !owner._pendingGeneratedRender && owner._generatedTabs.records.size === 0,
      'Closing the panel replayed a deferred generation',
    );
    owner.menu.close();
  }
}
