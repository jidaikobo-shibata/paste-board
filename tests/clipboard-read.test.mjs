import GLib from 'gi://GLib';
import { readClipboardText } from '../clipboardRead.js';
let checks = 0;
const equal = (a, b) => {
  if (a !== b) throw Error(`${a} != ${b}`);
  checks++;
};
function selection(bytes, mime = 'text/plain;charset=utf-8') {
  return {
    get_mimetypes: () => [mime],
    transfer_finish: () => true,
    transfer_async(type, selected, size, output, cancellable, callback) {
      equal(selected, mime);
      equal(size, 9);
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (!cancellable.is_cancelled())
          output.write_all(bytes.subarray(0, size), null);
        callback(this, {});
        return GLib.SOURCE_REMOVE;
      });
    },
  };
}
async function reject(read) {
  let failed = false;
  try {
    await read.promise;
  } catch {
    failed = true;
  }
  equal(failed, true);
}
async function main() {
  const options = { limit: 8, timeoutMs: 100 };
  equal(
    await readClipboardText(
      selection(new TextEncoder().encode('日本')),
      1,
      options,
    ).promise,
    '日本',
  );
  equal(
    await readClipboardText(
      selection(new Uint8Array([233]), 'STRING'),
      1,
      options,
    ).promise,
    'é',
  );
  await reject(
    readClipboardText(selection(new Uint8Array(9).fill(65)), 1, options),
  );
  await reject(readClipboardText(selection(new Uint8Array([255])), 1, options));
  await reject(
    readClipboardText(selection(new Uint8Array([65, 0, 66])), 1, options),
  );
  equal(
    await readClipboardText({ get_mimetypes: () => ['image/png'] }, 1, options)
      .promise,
    null,
  );
  const stalled = { get_mimetypes: () => ['text/plain'], transfer_async() {} };
  await reject(readClipboardText(stalled, 1, { limit: 8, timeoutMs: 10 }));
  const cancelled = readClipboardText(stalled, 1, options);
  cancelled.cancel();
  await reject(cancelled);
  print(`Bounded clipboard reads: ${checks} checks passed`);
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
