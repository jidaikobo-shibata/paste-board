import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { _ } from './i18n.js';
import { MAX_TEXT_BYTES } from './inputLimits.js';

// These targets represent the same plain text in a supported encoding.
const utf8Plain = (type) =>
  /^text\/plain\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(type);
export const isPlainTextTarget = (type) =>
  utf8Plain(type) ||
  ['text/plain', 'UTF8_STRING', 'TEXT', 'STRING'].includes(type);

// Mutter enforces the transfer bound before a clipboard owner can fill memory.
export function readClipboardText(
  selection,
  type,
  {
    limit = MAX_TEXT_BYTES,
    timeoutMs = 3000,
    requireRestorableText = false,
    allowTextOnlyFallback = false,
  } = {},
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
    let readFailure = _('Could not read clipboard text.');
    cancel = () => finish(new Error(readFailure));
    try {
      const types = selection.get_mimetypes(type) || [];
      const mixed =
        requireRestorableText && types.some((type) => !isPlainTextTarget(type));
      if (mixed)
        readFailure = _(
          'Paste skipped because the previous clipboard contents could not be saved as text.',
        );
      const mime =
        types.find(
          (type) =>
            /^text\/plain\s*;/i.test(type) &&
            /;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*(?:;|$)/i.test(type),
        ) ||
        ['UTF8_STRING', 'text/plain', 'STRING', 'TEXT'].find((candidate) =>
          types.includes(candidate),
        );
      if (!mime) {
        if (requireRestorableText && types.length)
          finish(
            new Error(
              _('Paste skipped to preserve non-text clipboard content.'),
            ),
          );
        else finish(null);
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
            if (mixed && !text.length) finish(new Error(readFailure));
            else if (mixed && !allowTextOnlyFallback) {
              const error = new Error(
                _(
                  'Paste skipped to preserve the formatting of your previous copy.',
                ),
              );
              error.code = 'text-only-fallback-disabled';
              finish(error);
            } else finish(null, text);
          } catch {
            finish(new Error(readFailure));
          }
        },
      );
    } catch {
      cancel();
    }
  });
  return { promise, cancel: () => cancel() };
}
