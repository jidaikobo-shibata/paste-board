import GLib from 'gi://GLib';
import { PasteSets } from '../pasteSets.js';
let checks = 0;
const equal = (actual, expected) => {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};
function rejects(action) {
  let failed = false;
  try {
    action();
  } catch {
    failed = true;
  }
  equal(failed, true);
}
async function rejectsAsync(action) {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  equal(failed, true);
}
const read = (path) =>
  JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
async function main() {
  const root = GLib.dir_make_tmp('paste-board-validation-cache.XXXXXX');
  const store = new PasteSets(root);
  let loaded;
  try {
    const id = store.create('Synthetic');
    const text = '日本語\n😀'.repeat(100);
    store.put(id, { text, name: 'Original' });
    await store.flush();
    const itemId = store.data.sets[0].items[0].id;
    equal(store._validatedTexts.has(text), true);
    const original = JSON.stringify(store.data);
    for (const invalid of [
      text.slice(0, -2) + '\0x',
      text + '\ud800',
      text + '\udfff',
      null,
      7,
      {},
    ]) {
      rejects(() => store.change((sets) => (sets[0].items[0].text = invalid)));
      equal(JSON.stringify(store.data), original);
    }
    rejects(() =>
      store.change((sets) => (sets[0].items[0].name = 'invalid\0')),
    );
    rejects(() =>
      store.change((sets) => sets[0].items.push({ ...sets[0].items[0] })),
    );
    rejects(() => store.change((sets) => (sets[0].items[0].kind = 'unknown')));
    // The public validator always checks input, even if a caller supplies a cache.
    const malformed = JSON.parse(original);
    malformed.sets[0].items[0].text = text + '\ud800';
    rejects(() =>
      PasteSets.validate(malformed, new Set([malformed.sets[0].items[0].text])),
    );
    rejects(() =>
      store.put(id, { id: itemId, text: '\x01'.repeat(3 * 1024 * 1024) }),
    );
    rejects(() =>
      store.put(id, { id: itemId, text: 'あ'.repeat(6 * 1024 * 1024) }),
    );
    equal(JSON.stringify(store.data), original);
    equal([...store._validatedTexts], [text]);
    await store.flush();
    equal(read(store.path), JSON.parse(original));
    const write = store._writeBytes.bind(store);
    const imported = 'Import must not survive failure '.repeat(20);
    store._writeBytes = () => Promise.reject(Error('Synthetic failure'));
    await rejectsAsync(() =>
      store.changeAndSave((sets) =>
        sets[0].items.push({
          id: 'imported',
          name: '',
          kind: 'text',
          text: imported,
        }),
      ),
    );
    equal(JSON.stringify(store.data), original);
    equal(store._validatedTexts.has(imported), false);
    store._writeBytes = write;
    const changed = text + 'edited';
    store.put(id, { id: itemId, text: changed });
    equal(store._validatedTexts.has(text), false);
    equal(store._validatedTexts.has(changed), true);
    store.put(id, { text: changed });
    store.removeItem(id, itemId);
    equal(store._validatedTexts.has(changed), true);
    await store.flush();
    loaded = new PasteSets(root);
    equal(loaded._validatedTexts.has(changed), true);
    await loaded.close();
    equal(loaded._validatedTexts, undefined);
    // Clearing the data must release cached text, not just remove it from the UI.
    store.clear(id);
    equal(store._validatedTexts.size, 0);
    store.put(id, { text: 'short text' });
    equal(store._validatedTexts.size, 0);
    await store.close();
    equal(store._validatedTexts, undefined);
    equal(read(store.path), store.data);
    print(`Paste-set validation cache: ${checks} checks passed`);
  } finally {
    await store.close();
    await loaded?.close();
    await PasteSets.waitForWrites();
    GLib.unlink(store.path);
    GLib.rmdir(root);
  }
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => (failure = error))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
