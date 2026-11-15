import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { MAX_TEXT_BYTES } from './inputLimits.js';
import { _ } from './i18n.js';

export const DIAGNOSTIC_PATH =
  '/org/gnome/Shell/Extensions/PasteBoard/Diagnostics';
export const DIAGNOSTIC_INTERFACE =
  'org.gnome.Shell.Extensions.PasteBoard.Diagnostics';
const XML = `<node><interface name="${DIAGNOSTIC_INTERFACE}">
<method name="Capture"><arg type="s" direction="out"/></method>
</interface></node>`;
export const diagnosticDirectory = () =>
  GLib.build_filenamev([
    GLib.get_user_state_dir(),
    'paste-board',
    'diagnostics',
  ]);
const isText = (mime) =>
  /^(text\/plain(?:;.*)?|UTF8_STRING|STRING|TEXT)$/i.test(mime);

function readFormat(selection, type, mime, limit, cancellable) {
  return new Promise((resolve) => {
    const started = GLib.get_monotonic_time();
    const output = Gio.MemoryOutputStream.new_resizable();
    const child = new Gio.Cancellable();
    const parentHandler = cancellable.connect(() => child.cancel());
    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      timer = null;
      child.cancel();
      return GLib.SOURCE_REMOVE;
    });
    const finish = (error = null) => {
      if (timer) GLib.Source.remove(timer);
      cancellable.disconnect(parentHandler);
      output.close(null);
      const bytes = output.steal_as_bytes().get_data();
      const result = {
        mime,
        elapsedMs: (GLib.get_monotonic_time() - started) / 1000,
        bytes: bytes.length,
        truncated: bytes.length > limit,
      };
      if (error) result.error = error.message;
      else if (!result.truncated) {
        try {
          const utf8 =
            mime === 'STRING'
              ? GLib.convert(bytes, 'UTF-8', 'ISO-8859-1')[0]
              : bytes;
          result.text = new TextDecoder('utf-8', { fatal: true }).decode(utf8);
        } catch {
          result.error = 'Text could not be decoded as UTF-8';
        }
      }
      resolve(result);
    };
    if (cancellable.is_cancelled()) child.cancel();
    try {
      selection.transfer_async(
        type,
        mime,
        limit + 1,
        output,
        child,
        (source, result) => {
          try {
            source.transfer_finish(result);
            finish();
          } catch (error) {
            finish(error);
          }
        },
      );
    } catch (error) {
      finish(error);
    }
  });
}

// Called only by an explicit diagnostic request. Never changes clipboard ownership.
export async function collectDiagnostic(
  selection,
  type,
  historyText,
  cancellable,
  { application = null } = {},
) {
  const report = {
    format: 'paste-board-clipboard-diagnostic',
    version: 1,
    capturedAt: new Date().toISOString(),
    focusedApplicationAtCapture: application,
    historyHead: {
      source: 'previously-recorded-history',
      text: historyText ?? null,
    },
    clipboard: { formats: [], results: [], changedDuringCapture: false },
  };
  const signal = selection.connect(
    'owner-changed',
    (_selection, changedType) => {
      if (changedType === type) report.clipboard.changedDuringCapture = true;
    },
  );
  try {
    const formats = selection.get_mimetypes(type) || [];
    report.clipboard.formats = formats
      .slice(0, 64)
      .map((mime) => mime.slice(0, 256));
    const targets = formats.filter(isText).slice(0, 8);
    let remaining = MAX_TEXT_BYTES;
    for (const mime of targets) {
      if (cancellable.is_cancelled())
        throw new Error(_('Diagnostic cancelled.'));
      if (report.clipboard.changedDuringCapture || remaining <= 0) break;
      const result = await readFormat(
        selection,
        type,
        mime,
        remaining,
        cancellable,
      );
      remaining -= result.bytes;
      report.clipboard.results.push(result);
    }
    if (cancellable.is_cancelled()) throw new Error(_('Diagnostic cancelled.'));
    report.clipboard.incomplete =
      report.clipboard.results.length < formats.filter(isText).length;
    report.finishedAt = new Date().toISOString();
    return report;
  } finally {
    selection.disconnect(signal);
  }
}

export async function saveDiagnostic(
  report,
  cancellable,
  directory = diagnosticDirectory(),
) {
  const folder = Gio.File.new_for_path(directory);
  GLib.mkdir_with_parents(directory, 0o700);
  const info = folder.query_info(
    'standard::type,standard::is-symlink,unix::uid',
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
    cancellable,
  );
  if (
    info.get_is_symlink() ||
    info.get_file_type() !== Gio.FileType.DIRECTORY ||
    info.get_attribute_uint32('unix::uid') !==
      new Gio.Credentials().get_unix_user()
  )
    throw new Error(_('The diagnostic folder is not safe to use.'));
  folder.set_attribute_uint32(
    'unix::mode',
    0o700,
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
    cancellable,
  );
  const file = folder.get_child(GLib.uuid_string_random() + '.json');
  let stream;
  try {
    stream = await new Promise((resolve, reject) =>
      file.create_async(
        Gio.FileCreateFlags.PRIVATE,
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (source, result) => {
          try {
            resolve(source.create_finish(result));
          } catch (error) {
            reject(error);
          }
        },
      ),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(report, null, 2));
    // GLib.Bytes owns its buffer throughout asynchronous I/O.
    let offset = 0;
    while (offset < bytes.length) {
      const written = await new Promise((resolve, reject) =>
        stream.write_bytes_async(
          new GLib.Bytes(bytes.subarray(offset)),
          GLib.PRIORITY_DEFAULT,
          cancellable,
          (source, result) => {
            try {
              resolve(source.write_bytes_finish(result));
            } catch (error) {
              reject(error);
            }
          },
        ),
      );
      if (written <= 0)
        throw new Error(_('Could not save the diagnostic record.'));
      offset += written;
    }
    await new Promise((resolve, reject) =>
      stream.close_async(
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (source, result) => {
          try {
            source.close_finish(result);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      ),
    );
    if (cancellable.is_cancelled()) throw new Error(_('Diagnostic cancelled.'));
    return file.get_path();
  } catch (error) {
    if (stream) {
      try {
        stream.close(null);
      } catch {
        /* Already closed. */
      }
      try {
        file.delete(null);
      } catch {
        /* No partial report to retain. */
      }
    }
    throw error;
  }
}

export class DiagnosticService {
  constructor(settings, snapshot) {
    this.settings = settings;
    this.snapshot = snapshot;
    this.changed = settings.connect('changed::debug-mode', () => {
      if (!settings.get_boolean('debug-mode')) this.cancellable?.cancel();
    });
    this.object = Gio.DBusExportedObject.wrapJSObject(XML, this);
    this.object.export(Gio.DBus.session, DIAGNOSTIC_PATH);
  }
  async CaptureAsync(_args, invocation) {
    if (
      this.closed ||
      this.cancellable ||
      !this.settings.get_boolean('debug-mode')
    ) {
      invocation.return_dbus_error(
        DIAGNOSTIC_INTERFACE + '.Unavailable',
        _(
          'Enable debug mode before running a diagnostic. Another diagnostic may be in progress.',
        ),
      );
      return;
    }
    const cancellable = (this.cancellable = new Gio.Cancellable());
    try {
      const { selection, type, historyText, application } = this.snapshot();
      const report = await collectDiagnostic(
        selection,
        type,
        historyText,
        cancellable,
        { application },
      );
      const path = await saveDiagnostic(report, cancellable);
      invocation.return_value(new GLib.Variant('(s)', [path]));
    } catch (error) {
      invocation.return_dbus_error(
        DIAGNOSTIC_INTERFACE + '.Error',
        error.message,
      );
    } finally {
      this.cancellable = null;
    }
  }
  destroy() {
    this.closed = true;
    this.cancellable?.cancel();
    this.settings.disconnect(this.changed);
    this.object.unexport();
  }
}
