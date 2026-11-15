// Real Shell layout and scrolling, with controlled synthetic command completions.
import GLib from 'gi://GLib';
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
    const { CommandPreviews } = await import(
      `file://${extension.path}/commandPreviews.js`
    );
    owner.settings.set_boolean('pause-command-previews', true);
    owner.settings.set_boolean('search-all-tabs', false);
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: 'preview-' + i,
      name: (i < 90 ? 'background ' : 'target ') + i,
      kind: 'command',
      text: '',
      command: 'printf synthetic-' + i,
      executionMode: 'direct',
      trimTrailingNewlines: true,
      previewOnOpen: true,
    }));
    owner._pasteSets.change((sets) =>
      sets.splice(0, sets.length, {
        id: 'preview-set',
        name: 'Synthetic previews',
        items,
      }),
    );
    await owner._pasteSets.flush();
    owner._commandPreviews?.destroy();
    let calls = [],
      active = 0,
      peak = 0;
    const previews = (owner._commandPreviews = new CommandPreviews(
      (id) => {
        const row = owner._pasteSetSection
          ._getMenuItems()
          .find((row) => row.entry?.id === id);
        if (row) owner._updateCommandPreviewRow(row);
      },
      {
        execute: (command) => {
          active++;
          peak = Math.max(peak, active);
          let resolve, reject;
          const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }).finally(() => active--);
          const run = {
            command,
            promise,
            cancelled: false,
            resolve,
            reject,
            cancel() {
              this.cancelled = true;
              reject(Error('Cancelled'));
            },
          };
          calls.push(run);
          return run;
        },
      },
    ));
    Main.overview.hide();
    owner.menu.open();
    await delay(100);
    owner._activePasteTab = 'preview-set';
    owner.searchEntry.set_text('target');
    owner.settings.set_boolean('pause-command-previews', false);
    await delay(80);
    assert(
      calls.length === 2 &&
        calls[0].command === items[90].command &&
        calls[1].command === items[91].command,
      'Filtered candidates did not start first',
    );
    owner.settings.set_boolean('search-all-tabs', true);
    owner.searchEntry.set_text('target 99');
    owner.searchEntry.grab_key_focus();
    await delay(80);
    const selected = previews.request(items[98], { timeoutMs: 2000 });
    owner._prioritizeVisiblePreviews();
    calls[0].resolve('first');
    await delay(30);
    assert(
      calls[2]?.command === items[98].command,
      'Viewport priority overrode explicit paste priority',
    );
    calls[2].resolve('selected');
    await selected.promise;
    await delay(30);
    assert(
      calls[3]?.command === items[99].command,
      'Cross-tab visible result was not prioritized',
    );
    assert(
      !calls[1].cancelled,
      'Running command was interrupted by priority change',
    );
    owner.settings.set_boolean('pause-command-previews', true);
    await delay(30);
    assert(
      previews.records.size === 0 && previews.active.size === 0,
      'Pause did not clear pending previews',
    );
    calls = [];
    active = 0;
    peak = 0;
    owner.settings.set_boolean('search-all-tabs', false);
    owner.searchEntry.set_text('');
    owner._pasteSetRenderLimit = 100;
    owner.settings.set_boolean('pause-command-previews', false);
    owner._renderPasteSets();
    owner.searchEntry.grab_key_focus();
    await delay(100);
    const scroll = owner._pasteSetScroll;
    scroll.vadjustment.value =
      scroll.vadjustment.upper - scroll.vadjustment.page_size;
    await delay(80);
    const [, top] = scroll.get_transformed_position();
    const [, height] = scroll.get_transformed_size();
    const visible = owner._pasteSetSection._getMenuItems().filter((row) => {
      if (!row.entry || !row.mapped) return false;
      const [, y] = row.get_transformed_position();
      const [, h] = row.get_transformed_size();
      return h > 0 && y < top + height && y + h > top;
    });
    assert(
      visible.length > 0 && Number(visible[0].entry.id.split('-')[1]) > 50,
      'Scroll did not reach tail',
    );
    const expected = visible[0].entry;
    assert(
      previews.queue[0]?.id === expected.id,
      'Queue did not follow actual viewport after scroll',
    );
    calls[0].resolve('done');
    await delay(30);
    assert(
      calls[2]?.command === expected.command,
      'Offscreen work ran before visible tail',
    );
    // All background items must still execute once after visible work.
    for (let round = 0; round < 120; round++) {
      calls.forEach((run) => run.resolve('synthetic output'));
      await delay(2);
      if (items.every((item) => previews.get(item)?.state === 'ready')) break;
    }
    assert(
      items.every((item) => previews.get(item)?.state === 'ready'),
      'Background work was starved',
    );
    assert(
      calls.length === 100 &&
        new Set(calls.map((run) => run.command)).size === 100,
      'Execution target changed or commands reran',
    );
    assert(
      peak === 2 && !calls.some((run) => run.cancelled),
      'Concurrency or cancellation changed',
    );
    previews.clear();
    await delay(10);
    const before = calls.length;
    owner._renderPasteSets();
    owner._queuePreviewPriorityUpdate();
    owner.menu.close();
    await delay(30);
    assert(
      !owner._previewPriorityIdle &&
        previews.records.size === 0 &&
        calls.length === before,
      'Closing launched queued work or retained priority source',
    );
  }
}
