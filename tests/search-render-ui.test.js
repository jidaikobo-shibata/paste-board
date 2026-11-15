// Synthetic benchmark in an isolated, headless GNOME Shell. No real user data.
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(0, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const assert = (v, message) => {
  if (!v) throw Error(message);
};
const stats = (values) => {
  values.sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.floor(values.length * 0.95)],
  };
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
  }
  finish(value) {
    GLib.file_set_contents(GLib.get_user_cache_dir() + '/result', value);
  }
  async check() {
    const extension = Main.extensionManager.lookup(
      'paste-board@jidaikobo.shibata',
    );
    const owner = extension.stateObj.clipboardIndicator;
    const DS = await import(`file://${extension.path}/dataStructures.js`);
    const { collectSearchResults, newestHistory } = await import(
      `file://${extension.path}/search.js`
    );
    Main.overview.hide();
    owner.settings.set_boolean('pause-command-previews', true);
    owner.menu.open();
    await delay(100);
    owner.historySection.removeAll();
    const history = new DS.LinkedList();
    for (let i = 0; i < 1000; i++)
      history.append(
        Object.assign(new DS.LLNode(), {
          id: 'h' + i,
          type: DS.TYPE_TEXT,
          text: 'unused history ' + i,
        }),
      );
    owner.entries = history;
    const manual = {
      id: 'manual',
      name: 'Manual',
      items: Array.from({ length: 1000 }, (_, i) => ({
        id: 'm' + i,
        kind: 'text',
        name: '',
        text: 'unused manual ' + i,
      })),
    };
    const generated = {
      id: 'generated',
      name: 'Generated',
      kind: 'generated',
      command: 'not executed',
      executionMode: 'direct',
      runOnOpen: false,
      runOnSearch: false,
      items: [],
    };
    const record = {
      state: 'ready',
      items: Array.from({ length: 1000 }, (_, i) => ({
        id: 'g' + i,
        kind: 'text',
        name: '',
        text: 'service generated ' + i,
      })),
    };
    owner._pasteSets.data = { version: 1, sets: [manual, generated] };
    owner._ensureGeneratedTabs();
    // Cached generated output: this benchmark never launches a command.
    owner._generatedTabs.get = (tab) =>
      tab.id === generated.id ? record : null;
    owner.searchEntry.set_text('service');
    owner.searchEntry.grab_key_focus();
    const report = [];
    for (const limit of [50, 200, 500]) {
      const share = Math.floor(limit / 3);
      let index = 0;
      for (const entry of history)
        entry.text =
          index++ < share
            ? 'service history ' + index
            : 'unused history ' + index;
      manual.items.forEach(
        (item, i) =>
          (item.text =
            i < share ? 'service manual ' + i : 'unused manual ' + i),
      );
      owner._searchRenderLimit = limit;
      for (let i = 0; i < 3; i++) owner._renderAllTabSearch();
      const times = [],
        scan = [],
        created = [];
      const section = owner._searchResultsSection;
      const add = section.addMenuItem;
      let additions = 0;
      section.addMenuItem = function (...args) {
        additions++;
        return add.apply(this, args);
      };
      try {
        for (let i = 0; i < 15; i++) {
          additions = 0;
          const start = GLib.get_monotonic_time();
          owner._renderAllTabSearch();
          times.push((GLib.get_monotonic_time() - start) / 1000);
          created.push(additions);
          const scanStart = GLib.get_monotonic_time();
          const result = collectSearchResults({
            query: 'service',
            history: newestHistory(history),
            historyName: 'History',
            sets: [manual, generated],
            getGenerated: () => record,
            limit,
          });
          scan.push((GLib.get_monotonic_time() - scanStart) / 1000);
          assert(result.count === limit, 'Unexpected result count');
          await delay(10);
        }
      } finally {
        section.addMenuItem = add;
      }
      let typing;
      if (limit === 50) {
        const durations = [];
        const allocations = [];
        section.addMenuItem = function (...args) {
          additions++;
          return add.apply(this, args);
        };
        try {
          for (const text of [
            'serv',
            'service',
            'service 1',
            'service',
            'service gen',
            'service',
            'SERVICE',
            'serv',
            'service',
            'service 1',
            'service',
            'service gen',
            'service',
            'SERVICE',
            'service',
          ]) {
            additions = 0;
            const start = GLib.get_monotonic_time();
            owner.searchEntry.set_text(text);
            durations.push((GLib.get_monotonic_time() - start) / 1000);
            allocations.push(additions);
            await delay(10);
          }
        } finally {
          section.addMenuItem = add;
        }
        typing = {
          ...stats(durations),
          medianCreated: stats(allocations).medianMs,
        };
      }
      report.push({
        sourceItems: 3000,
        typing,
        visibleRows: limit,
        render: stats(times),
        filterOnly: stats(scan),
        createdPerRender: stats(created).medianMs,
      });
    }
    if (GLib.getenv('PASTE_BOARD_BENCHMARK_BASELINE') !== '1') {
      const rows = () => owner._visiblePasteCandidates();
      const action = (row, title) =>
        row
          .get_children()
          .find(
            (child) =>
              child instanceof St.Button && child.accessible_name === title,
          );
      const { _ } = await import(`file://${extension.path}/i18n.js`);
      owner.searchEntry.set_text('service manual');
      owner._searchRenderLimit = 50;
      owner._renderAllTabSearch();
      const first = rows()[0];
      const edit = action(first, _('Edit name and content'));
      edit.grab_key_focus();
      owner._renderAllTabSearch();
      assert(rows()[0] === first, 'Unchanged candidate was recreated');
      assert(
        global.stage.get_key_focus() === edit,
        'Action-button focus was replaced',
      );
      const retained = rows();
      owner._searchRenderLimit = 100;
      owner._renderAllTabSearch();
      assert(rows().length === 100, 'Incremental rendering failed');
      assert(
        retained.every((row, index) => rows()[index] === row),
        'Appending results recreated earlier rows',
      );
      assert(
        rows()[0].shortcutLabel.text === '',
        'Default modifier should remain disabled',
      );
      owner.settings.set_int('quick-paste-modifiers', 8);
      owner._updateCandidateNumbers();
      assert(
        rows()[0].shortcutLabel.text === '1' &&
          rows()[8].shortcutLabel.text === '9' &&
          rows()[9].shortcutLabel.text === '',
        'Numbers do not follow visible candidates',
      );
      const second = rows()[1];
      [manual.items[0], manual.items[1]] = [manual.items[1], manual.items[0]];
      owner._renderAllTabSearch();
      assert(
        rows()[0] === second && rows()[1] === first,
        'Reordered results lost row identity',
      );
      const original = manual.items[1];
      manual.items[1] = {
        ...original,
        name: 'Renamed service manual',
        kind: 'command',
        command: 'printf synthetic',
        previewOnOpen: true,
        executionMode: 'direct',
        trimTrailingNewlines: true,
      };
      owner._renderAllTabSearch();
      assert(
        rows()[1] === first && first.label.text === 'Renamed service manual',
        'Edited content was not refreshed',
      );
      const editMethod = owner._editPasteSetItem;
      let edited;
      owner._editPasteSetItem = (id, item) => (edited = { id, item });
      edit.emit('clicked', 0);
      owner._editPasteSetItem = editMethod;
      assert(
        edited.id === manual.id &&
          edited.item === manual.items[1] &&
          edited.item.previewOnOpen,
        'Retained edit action used stale or derived data',
      );
      const deleteMethod = owner._confirmPasteSetDelete;
      let deleted;
      owner._confirmPasteSetDelete = (id, item) => (deleted = { id, item });
      action(first, _('Delete item')).emit('clicked', 0);
      owner._confirmPasteSetDelete = deleteMethod;
      assert(
        deleted.item === manual.items[1],
        'Retained delete action used stale data',
      );
      const focusIndex = rows().indexOf(first);
      const neighbor = rows()[focusIndex + 1];
      edit.grab_key_focus();
      manual.items = manual.items.filter((item) => item.id !== first.entry.id);
      owner._renderAllTabSearch();
      assert(
        global.stage.get_key_focus() === neighbor,
        'Removed result did not focus its nearest surviving neighbor',
      );
      owner.searchEntry.set_text('service generated');
      const generatedRow = rows()[0];
      owner._quickPasteFocusedCandidate = generatedRow;
      record.items[0] = {
        ...record.items[0],
        text: 'service generated changed',
      };
      owner._renderAllTabSearch();
      assert(
        rows()[0] === generatedRow &&
          generatedRow.entry.text === 'service generated changed' &&
          owner._quickPasteFocusedCandidate === generatedRow,
        'Generated result or paste focus became stale',
      );
      const replacement = {
        id: generated.id,
        name: 'Changed to manual',
        items: [record.items[0]],
      };
      owner._pasteSets.data.sets = [manual, replacement];
      owner._renderAllTabSearch();
      assert(
        rows()[0] !== generatedRow &&
          action(rows()[0], _('Edit name and content')),
        'Changed tab type retained incompatible controls',
      );
      owner.searchEntry.set_text('no-synthetic-match');
      const empty = owner._searchResultsSection._getMenuItems()[0];
      owner._renderAllTabSearch();
      assert(
        owner._searchResultsSection._getMenuItems()[0] === empty,
        'Empty-state row was recreated',
      );
      assert(rows().length === 0, 'Old results survived empty search');
    }
    GLib.file_set_contents(
      GLib.get_user_cache_dir() + '/search-render-benchmark.json',
      JSON.stringify(report, null, 2),
    );
  }
}
