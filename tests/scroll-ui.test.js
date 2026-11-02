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
    const DS = await import(`file://${extension.path}/dataStructures.js`);
    owner.settings.set_int('quick-paste-modifiers', 8);
    owner.settings.set_boolean('keep-menu-open', true);
    Main.overview.hide();
    owner.historySection.removeAll();
    owner.entries = new DS.LinkedList();
    for (let i = 0; i < 1000; i++) {
      const entry = new DS.LLNode();
      Object.assign(entry, {
        id: i + 1,
        type: DS.TYPE_TEXT,
        text: `scroll item ${i}`,
      });
      owner.entries.append(entry);
    }
    owner.menu.open();
    await delay(250);
    const rows = () => owner._visiblePasteCandidates();
    assert(rows().length === 50, 'Opening built more than the initial batch');
    assert(
      !owner._footerActions
        .get_children()
        .some((actor) => /page/i.test(actor.accessible_name || '')),
      'Footer still contains page controls',
    );
    const first = rows()[0];
    let worst = 0;
    for (let i = 0; i < 19; i++) {
      const before = rows().length;
      const start = GLib.get_monotonic_time();
      const a = owner.historyScrollView.vadjustment;
      a.value = a.upper - a.page_size;
      await delay(60);
      worst = Math.max(worst, (GLib.get_monotonic_time() - start) / 1000 - 60);
      assert(
        rows().length === before + 50,
        `Scroll batch ${i} failed: ${rows().length}`,
      );
      assert(
        rows()[0] === first && first.shortcutLabel.text === '1',
        'Appending replaced or renumbered first row',
      );
    }
    assert(
      rows()[999].entry.text === 'scroll item 0',
      'Oldest history is unreachable',
    );
    assert(
      new Set(rows().map((row) => row.entry.id)).size === 1000,
      'History duplicated',
    );
    // Both a local filtered view and a global result list must reach their tail.
    owner._searchAllTabs = false;
    owner.searchEntry.set_text('scroll item');
    await delay(150);
    assert(
      rows().length === 50,
      'New query retained the previous rendering budget',
    );
    const localFirst = rows()[0];
    let a = owner.historyScrollView.vadjustment;
    a.value = a.upper - a.page_size;
    await delay(100);
    assert(
      rows().length === 100 && rows()[0] === localFirst,
      'Local search failed to append without losing focus identity',
    );
    owner._searchAllTabs = true;
    owner._onSearchTextChanged();
    await delay(150);
    assert(rows().length === 50, 'Global initial batch is not bounded');
    a = owner._searchResultsScroll.vadjustment;
    a.value = a.upper - a.page_size;
    await delay(100);
    assert(
      rows().length === 100 && rows()[0].entry.text === 'scroll item 999',
      'Global search did not append in order',
    );
    owner.menu.close();
    owner.menu.open();
    await delay(200);
    assert(
      rows().length === 50 && owner.historyScrollView.vadjustment.value === 0,
      'Reopening did not restore bounded history at the top',
    );
    const id = owner._pasteSets.create('Long manual set');
    owner._pasteSets.change((sets) => {
      sets.find((set) => set.id === id).items = Array.from(
        { length: 120 },
        (_, i) => ({
          id: `manual-${i}`,
          name: '',
          kind: 'text',
          text: `manual candidate ${i}`,
        }),
      );
    });
    await owner._pasteSets.flush();
    owner._switchPasteTab(id);
    await delay(200);
    assert(rows().length === 50, 'Manual set built all rows at once');
    const manualFirst = rows()[0];
    a = owner._pasteSetScroll.vadjustment;
    a.value = a.upper - a.page_size;
    await delay(100);
    assert(
      rows().length === 100 && rows()[0] === manualFirst,
      'Manual set did not append',
    );
    const boundary = rows()[99];
    boundary._moveButtons[1].grab_key_focus();
    boundary._moveButtons[1].emit('clicked', 0);
    await delay(100);
    assert(
      rows().length === 120 &&
        rows()[100] === boundary &&
        boundary.contains(global.stage.get_key_focus()),
      'Keyboard reorder lost the focused item at the rendering boundary',
    );
    // Reset the budget before checking an item outside the first rendered batch.
    owner._switchPasteTab('history');
    owner._switchPasteTab(id);
    await delay(100);
    owner._searchAllTabs = false;
    owner.searchEntry.set_text('candidate 119');
    await delay(100);
    assert(
      rows().length === 1 && rows()[0].entry.text === 'manual candidate 119',
      'Local search missed unrendered manual data',
    );
    owner.settings.set_int('history-size', 2);
    assert(
      owner._pasteSets.data.sets.find((set) => set.id === id).items.length ===
        120,
      'Lowering limit destroyed manual items',
    );
    let rejected = false;
    try {
      owner._pasteSets.put(id, { text: 'blocked' });
    } catch {
      rejected = true;
    }
    assert(rejected, 'Configured limit did not block additions');
    owner.settings.set_int('history-size', 120);
    owner.settings.set_boolean('pause-command-previews', false);
    const generatedId = owner._pasteSets.create('Generated hosts', {
      kind: 'generated',
      executionMode: 'bash',
      runOnSearch: true,
      command: 'for ((i=0;i<120;i++)); do printf "ssh host%03d\\n" "$i"; done',
    });
    owner._switchPasteTab(generatedId);
    for (
      let i = 0;
      i < 100 &&
      owner._generatedTabs.get(
        owner._pasteSets.data.sets.find((set) => set.id === generatedId),
      )?.state !== 'ready';
      i++
    )
      await delay(40);
    await delay(100);
    assert(rows().length === 50, 'Generated tab did not bound rendering');
    a = owner._pasteSetScroll.vadjustment;
    a.value = a.upper - a.page_size;
    await delay(100);
    assert(rows().length === 100, 'Generated tab did not append');
    owner.searchEntry.set_text('host119');
    await delay(100);
    assert(
      rows().length === 1 && rows()[0].entry.text === 'ssh host119',
      'Local search missed unrendered generated host',
    );
    owner._searchAllTabs = true;
    owner._onSearchTextChanged();
    for (let i = 0; i < 100 && rows().length !== 1; i++) await delay(40);
    await delay(200);
    assert(
      rows().length === 1 && rows()[0].entry.text === 'ssh host119',
      'Cross-tab search missed unrendered generated host',
    );
    owner.settings.set_int('history-size', 119);
    await delay(100);
    const generatedSet = owner._pasteSets.data.sets.find(
      (set) => set.id === generatedId,
    );
    assert(
      owner._generatedTabs.get(generatedSet)?.state === 'error' &&
        rows().length === 0,
      'Lowered limit exposed partial generated output',
    );
    owner.settings.set_int('history-size', 120);
    await delay(100);
    assert(
      owner._generatedTabs.get(generatedSet)?.state === 'ready' &&
        rows().length === 1,
      'Raised limit failed to recover cached output',
    );
    owner.settings.set_int('history-size', 1000);
    console.log(
      `SCROLL_UI: 1000 rows reachable; largest batch overhead ${worst.toFixed(1)} ms`,
    );
  }
}
