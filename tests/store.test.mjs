import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Store from '../store.js';
import * as DS from '../dataStructures.js';

if (!GLib.get_user_cache_dir().startsWith('/tmp/paste-board-store-test.'))
  throw new Error('Use run-store-test.sh to isolate the cache.');
const directory = GLib.build_filenamev([
  GLib.get_user_cache_dir(),
  'store-test',
]);
let count = 0;
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  count++;
}
const read = () =>
  new Promise((resolve) =>
    Store.buildClipboardStateFromLog((entries, archived, nextId) =>
      resolve({ entries, archived, nextId }),
    ),
  );
const text = (entries) => entries.toArray().map((entry) => entry.text);
const loop = GLib.MainLoop.new(null, false);
let failure;
async function main() {
  Store.init('store-test');
  const legacy = GLib.build_filenamev([
    GLib.get_user_cache_dir(),
    'clipboard-indicator@tudmotu.com',
  ]);
  GLib.mkdir_with_parents(legacy, 0o700);
  GLib.file_set_contents(legacy + '/registry.txt', '["must stay untouched"]');
  let state = await read();
  equal(text(state.entries), []);
  equal(state.nextId, 1);
  equal(
    new TextDecoder().decode(
      GLib.file_get_contents(legacy + '/registry.txt')[1],
    ),
    '["must stay untouched"]',
  );

  // Fixed binary records from the persisted format: archive, restore, move, delete.
  const records = [];
  const save = (value) =>
    records.push(1, ...new TextEncoder().encode(value), 0);
  const op = (type, id) =>
    records.push(
      type,
      id & 255,
      (id >>> 8) & 255,
      (id >>> 16) & 255,
      (id >>> 24) & 255,
    );
  save('older');
  save('saved archive');
  op(3, 2);
  save('restore then delete');
  op(3, 3);
  op(4, 3);
  save('newest');
  op(5, 1);
  op(2, 3);
  GLib.file_set_contents(directory + '/database.log', new Uint8Array(records));
  state = await read();
  equal(text(state.entries), ['newest', 'older']);
  equal(text(state.archived), ['saved archive']);
  equal(state.nextId, 5);
  const build = () => {
    const all = [...state.archived, ...state.entries];
    all.forEach((entry, index) => {
      entry.diskId = index + 1;
    });
    return all;
  };
  await new Promise((resolve) => Store.resetDatabase(build, resolve));
  state = await read();
  equal(text(state.entries), ['newest', 'older']);
  equal(text(state.archived), ['saved archive']);
  const oldest = state.entries.head;
  Store.moveEntryToEnd(oldest.diskId);
  state.entries.append(oldest);
  const removed = state.entries.head;
  Store.deleteTextEntry(removed.diskId);
  removed.detach();
  // A queued compaction is also a barrier for pending append-only writes.
  await new Promise((resolve) => Store.resetDatabase(build, resolve));
  state = await read();
  equal(text(state.entries), ['newest']);
  equal(text(state.archived), ['saved archive']);
  state.entries = new DS.LinkedList();
  await new Promise((resolve) => Store.resetDatabase(build, resolve));
  state = await read();
  equal(text(state.entries), []);
  equal(text(state.archived), ['saved archive']);
  Store.destroy();
}
const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
  failure = new Error('Store test timed out');
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
main()
  .catch((error) => {
    failure = error;
  })
  .finally(() => loop.quit());
loop.run();
GLib.Source.remove(timer);
if (failure) throw failure;
print(`History store: ${count} checks passed`);
