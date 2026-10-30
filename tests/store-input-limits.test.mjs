import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Store from '../store.js';
import { MAX_TEXT_BYTES, MAX_LOG_BYTES } from '../inputLimits.js';
if (!GLib.get_user_cache_dir().startsWith('/tmp/paste-board-store-test.'))
  throw Error('Isolated cache required');
let checks = 0;
const equal = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${a} != ${b}`);
  checks++;
};
const read = () =>
  new Promise((resolve) =>
    Store.buildClipboardStateFromLog((entries) =>
      resolve(entries.toArray().map((e) => e.text)),
    ),
  );
async function main() {
  const dir = GLib.get_user_cache_dir() + '/bounded-store';
  GLib.mkdir_with_parents(dir, 0o700);
  const path = dir + '/database.log';
  const bytes = new Uint8Array(MAX_TEXT_BYTES + 10).fill(65);
  bytes.set([1, 103, 111, 111, 100, 0, 1]);
  bytes[bytes.length - 1] = 0;
  GLib.file_set_contents(path, bytes);
  let backup;
  Store.init('bounded-store', {
    onError: (error, file) => {
      backup = file;
    },
  });
  equal(await read(), ['good']);
  equal(
    Gio.File.new_for_path(backup)
      .query_info('standard::size', 0, null)
      .get_size(),
    bytes.length,
  );
  equal(
    Gio.File.new_for_path(path)
      .query_info('standard::size', 0, null)
      .get_size(),
    6,
  );
  await Store.destroy();
  const sparse = Gio.File.new_for_path(path).replace_readwrite(
    null,
    false,
    Gio.FileCreateFlags.PRIVATE,
    null,
  );
  sparse.truncate(MAX_LOG_BYTES + 1, null);
  sparse.close(null);
  Store.init('bounded-store');
  equal(await read(), []);
  equal(await Store.storeTextEntry('must not replace original'), false);
  await Store.destroy();
  equal(
    Gio.File.new_for_path(path)
      .query_info('standard::size', 0, null)
      .get_size(),
    MAX_LOG_BYTES + 1,
  );
  print(`Bounded history reads: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((e) => {
    failure = e;
  })
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
