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
    Store.buildClipboardStateFromLog((entries, archived, nextId, nextDiskId) =>
      resolve({ entries, archived, nextId, nextDiskId }),
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
  await Store.destroy();
  await faultCases();
}
function filesStartingWith(prefix) {
  const result = [];
  const iterator = Gio.File.new_for_path(directory).enumerate_children(
    'standard::name',
    Gio.FileQueryInfoFlags.NONE,
    null,
  );
  let info;
  while ((info = iterator.next_file(null)))
    if (info.get_name().startsWith(prefix)) result.push(info.get_name());
  iterator.close(null);
  return result.sort();
}

async function faultCases() {
  const path = directory + '/database.log';
  const prefix = new Uint8Array([
    1,
    ...new TextEncoder().encode('archive'),
    0,
    3,
    1,
    0,
    0,
    0,
    1,
    ...new TextEncoder().encode('kept'),
    0,
  ]);
  const original = new Uint8Array([...prefix, 1, 88, 89]);
  GLib.file_set_contents(path, original);
  const errors = [];
  Store.init('store-test', {
    onError: (error, backup, recovered) =>
      errors.push({ error, backup, recovered }),
  });
  let loaded = await read();
  equal(text(loaded.entries), ['kept']);
  equal(text(loaded.archived), ['archive']);
  equal(loaded.nextDiskId, 3);
  equal(errors.length, 1);
  equal(errors[0].recovered, true);
  equal(
    Array.from(GLib.file_get_contents(errors[0].backup)[1]),
    Array.from(original),
  );
  const firstBackup = errors[0].backup;
  await Store.destroy();

  // The repaired file can be read normally; a later fault must not overwrite its backup.
  Store.init('store-test', {
    onError: (error, backup) => errors.push({ error, backup }),
  });
  loaded = await read();
  equal(text(loaded.entries), ['kept']);
  equal(text(loaded.archived), ['archive']);
  equal(errors.length, 1);
  await Store.destroy();
  GLib.file_set_contents(path, new Uint8Array([...prefix, 2, 1]));
  Store.init('store-test', {
    onError: (error, backup) => errors.push({ error, backup }),
  });
  loaded = await read();
  equal(text(loaded.entries), ['kept']);
  equal(text(loaded.archived), ['archive']);
  equal(filesStartingWith('corrupted-').length, 2);
  equal(
    Array.from(GLib.file_get_contents(firstBackup)[1]),
    Array.from(original),
  );
  await Store.destroy();

  // Invalid references and unknown record types also retain all readable archives.
  for (const suffix of [[5, 99, 0, 0, 0], [255]]) {
    GLib.file_set_contents(path, new Uint8Array([...prefix, ...suffix]));
    Store.init('store-test');
    loaded = await read();
    equal(text(loaded.entries), ['kept']);
    equal(text(loaded.archived), ['archive']);
    await Store.destroy();
  }

  // An unreadable path must complete initialization without overwriting the source.
  GLib.unlink(path);
  GLib.mkdir_with_parents(path, 0o700);
  GLib.file_set_contents(path + '/marker', 'do not replace');
  Store.init('store-test');
  loaded = await read();
  equal(text(loaded.entries), []);
  equal(await Store.storeTextEntry('in memory only'), false);
  equal(
    new TextDecoder().decode(GLib.file_get_contents(path + '/marker')[1]),
    'do not replace',
  );
  await Store.destroy();
  GLib.unlink(path + '/marker');
  GLib.rmdir(path);

  const node = (id, value, archived = false) => {
    const entry = new DS.LLNode();
    Object.assign(entry, {
      id,
      diskId: id,
      type: DS.TYPE_TEXT,
      text: value,
      archived,
    });
    return entry;
  };
  const archive = node(1, 'protected archive', true);
  const base = node(2, 'base');
  const memory = [archive, base];
  const build = () => memory;
  let failures = 0;
  GLib.mkdir_with_parents(path, 0o700);
  Store.init('store-test', {
    currentStateBuilder: build,
    onError: () => failures++,
  });
  equal(await Store.storeTextEntry('base'), false);
  equal(await Store.moveEntryToEnd(2), false);
  equal(failures, 1);
  GLib.rmdir(path);
  // Queue operations with obsolete disk IDs before recovery. The full snapshot
  // includes these changes once; replaying the old records would corrupt it.
  const next = node(3, 'next');
  memory.push(next);
  const append = Store.storeTextEntry('next');
  memory.splice(1, 2, next, base);
  const move = Store.moveEntryToEnd(2);
  equal(await append, true);
  equal(await move, true);
  loaded = await read();
  equal(text(loaded.entries), ['next', 'base']);
  equal(text(loaded.archived), ['protected archive']);
  const last = node(4, 'last-日本語🙂\n');
  memory.push(last);
  equal(await Store.storeTextEntry('last-日本語🙂\n'), true);
  const deletion = Store.deleteTextEntry(base.diskId);
  memory.splice(memory.indexOf(base), 1);
  equal(await deletion, true);
  loaded = await read();
  equal(text(loaded.entries), ['next', 'last-日本語🙂\n']);
  equal(text(loaded.archived), ['protected archive']);
  await Store.destroy();

  // Replacement failures must not report cleanup success or block future retries.
  GLib.unlink(path);
  GLib.mkdir_with_parents(path, 0o700);
  Store.init('store-test', { currentStateBuilder: build });
  let completed = 0;
  equal(await Store.resetDatabase(build, () => completed++), false);
  equal(completed, 0);
  GLib.rmdir(path);
  equal(await Store.resetDatabase(build, () => completed++), true);
  equal(completed, 1);
  loaded = await read();
  equal(text(loaded.entries), ['next', 'last-日本語🙂\n']);
  equal(text(loaded.archived), ['protected archive']);
  const mode = Gio.File.new_for_path(path)
    .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
    .get_attribute_uint32('unix::mode');
  equal(mode & 0o777, 0o600);
  await Store.destroy();

  // Disabling is also a final save opportunity after the storage fault clears.
  GLib.unlink(path);
  GLib.mkdir_with_parents(path, 0o700);
  Store.init('store-test', { currentStateBuilder: build });
  equal(await Store.storeTextEntry('failed before disable'), false);
  GLib.rmdir(path);
  equal(await Store.destroy(), true);
  Store.init('store-test');
  loaded = await read();
  equal(text(loaded.entries), ['next', 'last-日本語🙂\n']);
  equal(text(loaded.archived), ['protected archive']);

  // A new instance waits for the previous instance's queued writes and close.
  const pending = Store.storeTextEntry('queued before disable');
  const closing = Store.destroy();
  Store.init('store-test');
  loaded = await read();
  equal(await pending, true);
  equal(await closing, true);
  equal(text(loaded.entries), [
    'next',
    'last-日本語🙂\n',
    'queued before disable',
  ]);
  equal(text(loaded.archived), ['protected archive']);
  await Store.destroy();
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
