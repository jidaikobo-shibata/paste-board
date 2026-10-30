import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { PasteSets } from '../pasteSets.js';

let checks = 0;
const equal = (actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  checks++;
};
const read = (path) =>
  JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
const rejected = async (promise) => {
  let failed = false;
  try {
    await promise;
  } catch {
    failed = true;
  }
  equal(failed, true);
};
async function main() {
  const directory = GLib.dir_make_tmp('paste-board-write-test.XXXXXX');
  const store = new PasteSets(directory);
  try {
    const id = store.create('Initial');
    await store.flush();
    equal(read(store.path), store.data);
    const originalWrite = store._writeBytes.bind(store);
    const writes = [];
    store._writeBytes = (bytes) =>
      new Promise((resolve, reject) => writes.push({ bytes, resolve, reject }));
    store.rename(id, 'First');
    store.rename(id, 'Second');
    store.rename(id, 'Latest');
    equal(writes.length, 1);
    equal(store.data.sets[0].name, 'Latest');
    equal(
      JSON.parse(new TextDecoder().decode(writes[0].bytes)).sets[0].name,
      'First',
    );
    const flushing = store.flush();
    writes[0].resolve();
    await Promise.resolve();
    equal(writes.length, 2);
    equal(
      JSON.parse(new TextDecoder().decode(writes[1].bytes)).sets[0].name,
      'Latest',
    );
    writes[1].resolve();
    await flushing;
    equal(writes.length, 2);
    let errors = 0;
    store._onError = () => errors++;
    store.rename(id, 'Failed old edit');
    store.rename(id, 'Newest retained edit');
    const failing = store.flush();
    writes[2].reject(new Error('Disk failure'));
    await rejected(failing);
    equal(errors, 1);
    equal(store.data.sets[0].name, 'Newest retained edit');
    // The original file was not overwritten by the failed/simulated writes.
    equal(read(store.path).sets[0].name, 'Initial');
    store._writeBytes = originalWrite;
    await store.flush();
    equal(read(store.path), store.data);
    // Real filesystem failure, preserving an independently saved good file.
    const backup = directory + '/previous.json';
    Gio.File.new_for_path(store.path).move(
      Gio.File.new_for_path(backup),
      Gio.FileCopyFlags.NONE,
      null,
      null,
    );
    GLib.mkdir_with_parents(store.path, 0o700);
    store.rename(id, 'After I/O failure');
    await rejected(store.flush());
    equal(read(backup).sets[0].name, 'Newest retained edit');
    equal(errors, 2);
    GLib.rmdir(store.path);
    await store.flush();
    equal(read(store.path).sets[0].name, 'After I/O failure');
    // Close and re-enable must wait for all writes without accepting new edits.
    store._writeBytes = (bytes) =>
      new Promise((resolve) => writes.push({ bytes, resolve }));
    store.rename(id, 'Before close');
    const closing = store.close();
    let ready = false;
    const waiting = PasteSets.waitForWrites().then(() => {
      ready = true;
    });
    await Promise.resolve();
    equal(ready, false);
    let refused = false;
    try {
      store.rename(id, 'After close');
    } catch {
      refused = true;
    }
    equal(refused, true);
    equal(store.data.sets[0].name, 'Before close');
    const last = writes.at(-1);
    await originalWrite(last.bytes);
    last.resolve();
    await closing;
    await waiting;
    equal(ready, true);
    equal(new PasteSets(directory).data.sets[0].name, 'Before close');
    GLib.unlink(backup);
    print(`Asynchronous paste-set writes: ${checks} checks passed`);
  } finally {
    await PasteSets.waitForWrites();
    GLib.unlink(store.path);
    GLib.rmdir(directory);
  }
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => {
    failure = error;
  })
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
