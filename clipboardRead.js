import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { _ } from './i18n.js';
import { MAX_TEXT_BYTES } from './inputLimits.js';

// Mutter enforces the transfer bound before a clipboard owner can fill memory.
export function readClipboardText(
  selection,
  type,
  { limit = MAX_TEXT_BYTES, timeoutMs = 3000 } = {},
) {
  const cancellable = new Gio.Cancellable();
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const output = Gio.MemoryOutputStream.new_resizable();
    const finish = (error, text = null) => {
      if (settled) return;
      settled = true;
      if (timer) GLib.Source.remove(timer);
      timer = null;
      cancellable.cancel();
      if (error) reject(error);
      else resolve(text);
    };
    cancel = () => finish(new Error(_('Could not read clipboard text.')));
    try {
      const types = selection.get_mimetypes(type) || [];
      const mime =
        [
          'text/plain;charset=utf-8',
          'UTF8_STRING',
          'text/plain',
          'STRING',
          'TEXT',
        ].find((candidate) => types.includes(candidate)) ||
        types.find((candidate) =>
          /^text\/plain;.*charset=utf-8/i.test(candidate),
        );
      if (!mime) {
        finish(null);
        return;
      }
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timer = null;
        cancel();
        return GLib.SOURCE_REMOVE;
      });
      selection.transfer_async(
        type,
        mime,
        limit + 1,
        output,
        cancellable,
        (source, result) => {
          try {
            source.transfer_finish(result);
            output.close(null);
            const bytes = output.steal_as_bytes().get_data();
            if (bytes.length > limit) {
              const error = new Error(_('Copied text exceeds the size limit.'));
              error.code = 'size-limit';
              finish(error);
              return;
            }
            if (bytes.includes(0)) throw new Error('Invalid clipboard text');
            const utf8 =
              mime === 'STRING'
                ? GLib.convert(bytes, 'UTF-8', 'ISO-8859-1')[0]
                : bytes;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(utf8);
            finish(null, text);
          } catch {
            finish(new Error(_('Could not read clipboard text.')));
          }
        },
      );
    } catch {
      cancel();
    }
  });
  return { promise, cancel: () => cancel() };
}
