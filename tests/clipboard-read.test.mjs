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
  const protectedRead = { ...options, requireRestorableText: true };
  equal(
    await readClipboardText({ get_mimetypes: () => [] }, 1, protectedRead)
      .promise,
    null,
  );
  await reject(
    readClipboardText({ get_mimetypes: () => ['image/png'] }, 1, protectedRead),
  );
  for (const mime of [
    'text/plain; charset=UTF-8',
    'TEXT/PLAIN; charset = "utf-8"',
  ]) {
    const source = selection(new TextEncoder().encode('日本'), mime);
    source.get_mimetypes = () => ['STRING', 'text/plain', mime];
    equal(await readClipboardText(source, 1, protectedRead).promise, '日本');
  }
  for (const extra of ['text/html', 'image/png', 'application/x-writer']) {
    const source = selection(new TextEncoder().encode('body'));
    const plain = source.get_mimetypes()[0];
    source.get_mimetypes = () => [plain, extra];
    equal(await readClipboardText(source, 1, options).promise, 'body');
    await reject(readClipboardText(source, 1, protectedRead));
    equal(
      await readClipboardText(source, 1, {
        ...protectedRead,
        allowTextOnlyFallback: true,
      }).promise,
      'body',
    );
  }
  await reject(
    readClipboardText({ get_mimetypes: () => ['image/png'] }, 1, {
      ...protectedRead,
      allowTextOnlyFallback: true,
    }),
  );
  const empty = selection(new Uint8Array());
  empty.get_mimetypes = () => ['text/plain;charset=utf-8', 'text/html'];
  await reject(
    readClipboardText(empty, 1, {
      ...protectedRead,
      allowTextOnlyFallback: true,
    }),
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
