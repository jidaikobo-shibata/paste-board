import GLib from 'gi://GLib';
import St from 'gi://St';
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
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(40);
      }
      throw Error('Timed out waiting for history-only UI');
    };
    assert(
      !owner._pasteSets && owner._searchAllTabs,
      'Test requires unreadable paste sets with all-tabs scope enabled',
    );
    const clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, 'prod server history');
    await wait(() => owner.entries.findTextItem('prod server history'));
    clipboard.set_text(St.ClipboardType.CLIPBOARD, 'another history item');
    await wait(() => owner.entries.findTextItem('another history item'));
    Main.overview.hide();
    owner.menu.open();
    await delay(150);
    const query = async (text) => {
      owner.searchEntry.set_text(text);
      await delay(100);
    };
    const rows = () => owner._visiblePasteCandidates();
    assert(
      !owner.settings.get_boolean('enable-keybindings') &&
        owner.settings.get_strv('toggle-menu').length === 0 &&
        owner._historyPasteModifiers === 0,
      'Fresh shortcut defaults are not off',
    );
    assert(
      rows().every(
        (row) =>
          row.shortcutLabel.text === '' && !row.shortcutLabel.shortcutName,
      ),
      'Disabled shortcuts still show numbers',
    );
    assert(
      owner._shortcutsBindingIds.length === 0,
      'Fresh defaults registered a global shortcut',
    );
    const { default: Clutter } = await import('gi://Clutter');
    const keyboard = Clutter.get_default_backend()
      .get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    rows()[0].grab_key_focus();
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_0,
      Clutter.KeyState.PRESSED,
    );
    keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_0,
      Clutter.KeyState.RELEASED,
    );
    await delay(150);
    assert(
      owner.menu.isOpen && owner.searchEntry.get_text() === '0',
      'Disabled number paste consumed a plain digit',
    );
    await query('');
    owner.settings.set_int('quick-paste-modifiers', 8);
    await delay(100);
    assert(
      rows()[0].shortcutLabel.text === '1',
      'Enabling number shortcuts did not show numbers',
    );
    owner.settings.set_int('quick-paste-modifiers', 0);
    await delay(100);
    assert(
      rows().every((row) => row.shortcutLabel.text === ''),
      'Turning shortcuts off did not hide numbers',
    );

    await query('server prod');
    assert(
      !owner._isCrossTabSearch() &&
        rows().length === 1 &&
        rows()[0].entry.text === 'prod server history',
      'History-only AND search did not match',
    );
    assert(
      owner.scrollViewMenuSection.actor.visible &&
        !owner._searchResultsContainer.actor.visible &&
        !owner._pasteSetContainer.actor.visible,
      'Unavailable sets hid the history results',
    );
    await query('not present anywhere');
    assert(
      rows().length === 0,
      'History-only search retained nonmatching entries',
    );
    owner._renderAllTabSearch();
    assert(
      rows().length === 0,
      'Cross-search refresh did not fall back to history',
    );
    owner.settings.set_boolean('private-mode', true);
    await delay(100);
    assert(
      rows().length === 0 && !owner.scrollViewMenuSection.actor.visible,
      'Private mode exposed history after set load failure',
    );
    owner.settings.set_boolean('private-mode', false);
    await delay(100);
    await query('prod history');
    assert(
      rows().length === 1,
      'Leaving private mode broke history-only search',
    );
    owner.settings.set_boolean('search-all-tabs', false);
    await delay(100);
    assert(rows().length === 1, 'Scope toggle broke history-only search');
    owner.settings.set_boolean('search-all-tabs', true);
    await delay(100);
    assert(
      rows().length === 1,
      'All-tabs scope did not retain history fallback',
    );
    owner.menu.close();
    owner.menu.open();
    await delay(150);
    assert(
      !owner.searchEntry.get_text() && rows().length === 2,
      'Reopening did not restore ordinary history',
    );
    const path =
      GLib.get_user_config_dir() +
      '/paste-board@jidaikobo.shibata/paste-sets.json';
    assert(
      new TextDecoder().decode(GLib.file_get_contents(path)[1]) === '{invalid',
      'Failed paste-set data was overwritten',
    );
    owner.menu.close();
  }
}
