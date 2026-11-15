// Optional synthetic benchmark. Writes only to a newly created temporary directory.
import GLib from 'gi://GLib';
import { PasteSets } from '../pasteSets.js';
const now = () => GLib.get_monotonic_time() / 1000;
function stats(values) {
  values.sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.floor(values.length * 0.95)],
  };
}
async function main() {
  const report = [];
  for (const bodyBytes of [64, 1024, 8192]) {
    const root = GLib.dir_make_tmp('paste-board-save-benchmark.XXXXXX');
    const store = new PasteSets(root);
    try {
      await store.flush();
      const body = 'x'.repeat(bodyBytes - 16) + '\n日本語\n';
      store.change((sets) =>
        sets.push({
          id: 'set',
          name: 'Synthetic',
          items: Array.from({ length: 1000 }, (_, i) => ({
            id: 'item-' + i,
            kind: 'text',
            name: '',
            text: body + i,
          })),
        }),
      );
      await store.flush();
      const samples = {
        preparation: [],
        validation: [],
        json: [],
        utf8: [],
        clone: [],
        writeOnly: [],
        burst: [],
        untilSaved: [],
      };
      let encodedBytes;
      for (let i = 0; i < 7; i++) {
        let start = now();
        PasteSets.validate(store.data);
        samples.validation.push(now() - start);
        start = now();
        const json = JSON.stringify(store.data);
        samples.json.push(now() - start);
        start = now();
        encodedBytes = new TextEncoder().encode(json);
        samples.utf8.push(now() - start);
        start = now();
        store._changedData(() => {});
        samples.clone.push(now() - start);
        start = now();
        store._encode(store.data);
        samples.preparation.push(now() - start);
        start = now();
        await store._writeBytes(encodedBytes);
        samples.writeOnly.push(now() - start);
      }
      const originalEncode = store._encode.bind(store);
      const originalWrite = store._writeBytes.bind(store);
      let encodes = 0,
        writes = 0;
      store._encode = (...args) => {
        encodes++;
        return originalEncode(...args);
      };
      store._writeBytes = (...args) => {
        writes++;
        return originalWrite(...args);
      };
      for (let run = 0; run < 7; run++) {
        const start = now();
        for (let edit = 0; edit < 10; edit++) {
          if (edit % 2)
            store.put('set', {
              id: 'item-0',
              name: 'edited ' + run + ' ' + edit,
              text: body + run + ' ' + edit,
            });
          else store.rename('set', 'Synthetic ' + run + ' ' + edit);
        }
        samples.burst.push(now() - start);
        await store.flush();
        samples.untilSaved.push(now() - start);
      }
      report.push({
        items: 1000,
        bodyBytes,
        storedBytes: encodedBytes.length,
        editsPerBurst: 10,
        bursts: 7,
        encodes,
        writes,
        measurements: Object.fromEntries(
          Object.entries(samples).map(([k, v]) => [k, stats(v)]),
        ),
      });
    } finally {
      await store.close();
      GLib.unlink(store.path);
      GLib.rmdir(root);
    }
  }
  print(JSON.stringify(report, null, 2));
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => (failure = error))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
