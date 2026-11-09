import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { textFitsLimit } from './inputLimits.js';

// Opt-in diagnostics. Incident contents go to private files, not the journal.
export class ClipboardDebug {
  constructor(
    selection,
    type,
    active,
    notify,
    {
      delays = [1000, 3000, 10000],
      confirmMs = 500,
      timeoutMs = 750,
      log = console.log,
      incidentDirectory = GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'paste-board',
        'clipboard-debug',
      ]),
    } = {},
  ) {
    Object.assign(this, {
      selection,
      type,
      active,
      notify,
      delays,
      confirmMs,
      timeoutMs,
      log,
      incidentDirectory,
    });
    this.cancel();
  }

  cancel() {
    this.generation = (this.generation || 0) + 1;
    if (this.timer) GLib.Source.remove(this.timer);
    this.timer = null;
    this.pending?.();
    this.pending = null;
  }

  observe(text) {
    this.cancel();
    if (!this.active()) return;
    const generation = this.generation;
    const snapshot = textFitsLimit(text)
      ? { text, acquiredAt: new Date().toISOString() }
      : null;
    let previous = 0;
    let index = 0;
    const next = () => {
      if (index >= this.delays.length || !this.valid(generation)) return;
      const elapsed = this.delays[index++];
      this.timer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        elapsed - previous,
        () => {
          this.timer = null;
          previous = elapsed;
          this.check(generation)
            .then((empty) => {
              if (!this.valid(generation)) return;
              if (!empty) {
                next();
                return;
              }
              this.timer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this.confirmMs,
                () => {
                  this.timer = null;
                  this.check(generation)
                    .then((confirmed) => {
                      if (!this.valid(generation)) return;
                      if (confirmed) {
                        this.record('empty-confirmed');
                        this.saveIncident(snapshot, generation).catch(() =>
                          this.record('incident-save-failed'),
                        );
                        return this.notify(() => this.valid(generation));
                      } else next();
                    })
                    .catch(() => this.failure());
                  return GLib.SOURCE_REMOVE;
                },
              );
            })
            .catch(() => this.failure());
          return GLib.SOURCE_REMOVE;
        },
      );
    };
    next();
  }

  valid(generation) {
    return generation === this.generation && this.active();
  }

  failure() {
    // Error strings from applications could contain private data.
    this.record('probe-error');
  }

  record(result, details = {}) {
    this.log(
      '[Paste Board clipboard-debug] ' +
        JSON.stringify({ time: new Date().toISOString(), result, ...details }),
    );
  }

  async saveIncident(snapshot, generation) {
    if (!snapshot || !this.valid(generation)) return;
    const detectedAt = new Date().toISOString();
    const formats = (this.selection.get_mimetypes(this.type) || [])
      .slice(0, 64)
      .map((mime) => mime.slice(0, 256));
    const directory = Gio.File.new_for_path(this.incidentDirectory);
    if (GLib.mkdir_with_parents(this.incidentDirectory, 0o700) !== 0)
      throw new Error('Could not create incident directory');
    const info = directory.query_info(
      'standard::type',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
      throw new Error('Invalid incident directory');
    directory.set_attribute_uint32(
      'unix::mode',
      0o700,
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    const file = directory.get_child(GLib.uuid_string_random() + '.json');
    const bytes = new GLib.Bytes(
      new TextEncoder().encode(
        JSON.stringify(
          {
            acquiredAt: snapshot.acquiredAt,
            detectedAt,
            generation,
            formats,
            text: snapshot.text,
          },
          null,
          2,
        ) + '\n',
      ),
    );
    await new Promise((resolve, reject) =>
      file.replace_contents_bytes_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (source, result) => {
          try {
            source.replace_contents_finish(result);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      ),
    );
    this.record('incident-saved', { generation, path: file.get_path() });
  }

  async check(generation) {
    if (!this.valid(generation)) return false;
    const types = [
      ...new Set(this.selection.get_mimetypes(this.type) || []),
    ].filter((mime) =>
      /^(text\/plain(?:;.*)?|UTF8_STRING|STRING|TEXT)$/i.test(mime),
    );
    // Bound both the work and metadata produced by an untrusted owner.
    if (
      !types.length ||
      types.length > 8 ||
      types.some((mime) => mime.length > 128)
    )
      return false;
    let allEmpty = true;
    for (const mime of types) {
      if (!this.valid(generation)) return false;
      const result = await this.probe(mime);
      if (!this.valid(generation)) return false;
      this.log(
        '[Paste Board clipboard-debug] ' +
          JSON.stringify({
            time: new Date().toISOString(),
            generation,
            mime,
            ...result,
          }),
      );
      if (result.result !== 'empty') allEmpty = false;
    }
    return allEmpty;
  }

  probe(mime) {
    return new Promise((resolve) => {
      const output = Gio.MemoryOutputStream.new_resizable();
      const cancellable = new Gio.Cancellable();
      let settled = false;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) GLib.Source.remove(timer);
        this.pending = null;
        cancellable.cancel();
        resolve({
          result,
          ...(result === 'empty'
            ? { bytes: 0 }
            : result === 'nonempty'
              ? { bytesAtLeast: 1 }
              : {}),
        });
      };
      this.pending = () => finish('cancelled');
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.timeoutMs, () => {
        timer = null;
        finish('timeout');
        return GLib.SOURCE_REMOVE;
      });
      try {
        this.selection.transfer_async(
          this.type,
          mime,
          1,
          output,
          cancellable,
          (source, result) => {
            try {
              source.transfer_finish(result);
              finish(output.get_data_size() === 0 ? 'empty' : 'nonempty');
            } catch {
              finish('error');
            } finally {
              try {
                output.close(null);
              } catch {
                /* Already closed. */
              }
            }
          },
        );
      } catch {
        finish('error');
        output.close(null);
      }
    });
  }
}
