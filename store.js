import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as DS from './dataStructures.js';
import { MAX_TEXT_BYTES, MAX_LOG_BYTES, textFitsLimit } from './inputLimits.js';

// Record numbers are stable: existing logs retain their text, archives and IDs.
const SAVE = 1;
const DELETE = 2;
const ARCHIVE = 3;
const RESTORE = 4;
const MOVE = 5;
const MAX_WASTED_OPS = 500;
const encoder = new TextEncoder();
let activeStore;
let previousClose = Promise.resolve();

function io(object, begin, finish, ...args) {
  return new Promise((resolve, reject) => {
    object[begin](...args, (source, result) => {
      try {
        resolve(source[finish](result));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function textRecord(text) {
  if (!textFitsLimit(text) || text.includes('\0'))
    throw new Error('Invalid history text');
  const encoded = encoder.encode(text);
  const bytes = new Uint8Array(encoded.length + 2);
  bytes[0] = SAVE;
  bytes.set(encoded, 1);
  return bytes;
}

function idRecord(type, id) {
  const bytes = new Uint8Array(5);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, id, true);
  return bytes;
}

function snapshot(entries) {
  // Freeze queued snapshots: later compaction can reassign the live nodes' IDs.
  return entries.map((entry, index) => {
    entry.diskId = index + 1;
    return {
      text: entry.text,
      archived: Boolean(entry.archived),
      diskId: index + 1,
    };
  });
}

function encodeSnapshot(entries) {
  const records = [];
  let size = 0;
  for (const entry of entries) {
    const text = textRecord(entry.text);
    records.push(text);
    size += text.length;
    if (entry.archived) {
      const archive = idRecord(ARCHIVE, entry.diskId);
      records.push(archive);
      size += archive.length;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const record of records) {
    bytes.set(record, offset);
    offset += record.length;
  }
  return bytes;
}

class HistoryStore {
  constructor(uuid, options, ready) {
    this.directory = GLib.build_filenamev([GLib.get_user_cache_dir(), uuid]);
    this.file = Gio.File.new_for_path(this.directory + '/database.log');
    this.options = options;
    this.ready = ready;
    this.queue = [];
    this.revision = this.persistedRevision = this.wasted = 0;
    GLib.mkdir_with_parents(this.directory, 0o700);
  }

  report(error, backup = null, recovered = false) {
    // A persistent I/O failure should not create one notification per copy.
    if (this.reported && !backup) return;
    this.reported = true;
    console.error(error);
    try {
      this.options.onError?.(error, backup, recovered);
    } catch (notificationError) {
      console.error(notificationError);
    }
  }

  enqueue(task) {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      await this.ready;
      while (this.queue.length) {
        const { task, resolve } = this.queue.shift();
        try {
          await task();
          resolve(true);
        } catch (error) {
          this.needsSnapshot = true;
          await this.closeStream();
          this.report(error);
          resolve(false);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async closeStream() {
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      try {
        await io(stream, 'close_async', 'close_finish', 0, null);
      } catch (error) {
        this.report(error);
      }
    }
  }

  async replace(entries) {
    await this.closeStream();
    const bytes = encodeSnapshot(entries);
    // GBytes with zero bytes can pass a NULL buffer to GLib's async writer.
    // Atomically create/truncate an empty replacement without issuing a write.
    if (!bytes.length) {
      const empty = await io(
        this.file,
        'replace_async',
        'replace_finish',
        null,
        false,
        Gio.FileCreateFlags.PRIVATE,
        0,
        null,
      );
      await io(empty, 'close_async', 'close_finish', 0, null);
      return;
    }
    await io(
      this.file,
      'replace_contents_bytes_async',
      'replace_contents_finish',
      new GLib.Bytes(bytes),
      null,
      false,
      Gio.FileCreateFlags.PRIVATE,
      null,
    );
  }

  mutation(write, onComplete = null) {
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (this.readBlocked)
        throw new Error('History is read-only after a load failure.');
      if (revision > this.persistedRevision) {
        if (this.needsSnapshot) {
          const build = this.options.currentStateBuilder;
          if (!build)
            throw new Error(
              'History must be rebuilt before saving can resume.',
            );
          // Includes all mutations queued so far. Skip their obsolete append records
          // after this snapshot; their old disk IDs may no longer be valid.
          const covered = this.revision;
          const state = snapshot(build());
          await this.replace(state);
          this.persistedRevision = covered;
          this.needsSnapshot = false;
        } else {
          await write();
          this.persistedRevision = revision;
        }
        this.reported = false;
      }
      onComplete?.();
    });
  }

  append(bytes) {
    return this.mutation(async () => {
      if (!this.stream)
        this.stream = await io(
          this.file,
          'append_to_async',
          'append_to_finish',
          Gio.FileCreateFlags.PRIVATE,
          0,
          null,
        );
      // GLib.Bytes owns the buffer until asynchronous I/O completes. Passing
      // a temporary marshalled Uint8Array to write_all_async can free it early.
      let offset = 0;
      while (offset < bytes.length) {
        const written = await io(
          this.stream,
          'write_bytes_async',
          'write_bytes_finish',
          new GLib.Bytes(bytes.subarray(offset)),
          0,
          null,
        );
        if (written <= 0) throw new Error('Incomplete history write');
        offset += written;
      }
    });
  }

  reset(build, onComplete) {
    this.options.currentStateBuilder = build;
    const state = snapshot(build());
    this.wasted = 0;
    return this.mutation(() => this.replace(state), onComplete);
  }

  read(callback) {
    return this.enqueue(async () => {
      const state = {
        entries: new DS.LinkedList(),
        archived: new DS.LinkedList(),
        nextId: 1,
      };
      let stream;
      try {
        const info = await io(
          this.file,
          'query_info_async',
          'query_info_finish',
          'standard::size,standard::type',
          Gio.FileQueryInfoFlags.NONE,
          0,
          null,
        );
        if (
          info.get_file_type() !== Gio.FileType.REGULAR ||
          info.get_size() > MAX_LOG_BYTES
        )
          throw new Error('History exceeds size limit');
        const input = await io(this.file, 'read_async', 'read_finish', 0, null);
        stream = Gio.DataInputStream.new(input);
        stream.set_byte_order(Gio.DataStreamByteOrder.LITTLE_ENDIAN);
      } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
          // Never replace unreadable data with an empty in-memory history.
          this.readBlocked = true;
          this.report(error);
        }
        await callback(state.entries, state.archived, state.nextId);
        return;
      }
      let damaged;
      try {
        let processed = 0;
        const requireBytes = async (count, eofAllowed = false) => {
          while (stream.get_available() < count) {
            const filled = await io(
              stream,
              'fill_async',
              'fill_finish',
              -1,
              0,
              null,
            );
            if (!filled) {
              if (eofAllowed && stream.get_available() === 0) return false;
              throw new Error('Truncated history record');
            }
          }
          return true;
        };
        while (await requireBytes(1, true)) {
          const type = stream.read_byte(null);
          processed++;
          if (processed > MAX_LOG_BYTES)
            throw new Error('History exceeds size limit');
          if (type === SAVE) {
            const chunks = [];
            let size = 0;
            while (true) {
              await requireBytes(1);
              const available = stream.peek_buffer();
              const terminator = available.indexOf(0);
              const count = terminator < 0 ? available.length : terminator;
              size += count;
              processed += count + (terminator >= 0 ? 1 : 0);
              if (processed > MAX_LOG_BYTES)
                throw new Error('History exceeds size limit');
              if (size > MAX_TEXT_BYTES)
                throw new Error('History text exceeds size limit');
              if (count) chunks.push(stream.read_bytes(count, null).get_data());
              if (terminator >= 0) {
                stream.read_byte(null);
                break;
              }
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
              bytes,
            );
            const entry = new DS.LLNode();
            entry.id = entry.diskId = state.nextId++;
            entry.type = DS.TYPE_TEXT;
            entry.text = text || '';
            entry.archived = false;
            state.entries.append(entry);
          } else {
            if (![DELETE, ARCHIVE, RESTORE, MOVE].includes(type))
              throw new Error('Unknown history record');
            await requireBytes(4);
            processed += 4;
            if (processed > MAX_LOG_BYTES)
              throw new Error('History exceeds size limit');
            const id = stream.read_uint32(null);
            const entry =
              state.entries.findById(id) || state.archived.findById(id);
            if (
              !entry ||
              (type === ARCHIVE && entry.archived) ||
              (type === RESTORE && !entry.archived)
            )
              throw new Error('Invalid history record reference');
            if (type === DELETE) {
              entry.detach();
              this.wasted += 2;
            } else if (type === ARCHIVE || type === RESTORE) {
              entry.archived = type === ARCHIVE;
              (entry.archived ? state.archived : state.entries).append(entry);
            } else {
              (entry.archived ? state.archived : state.entries).append(entry);
              this.wasted++;
            }
          }
        }
      } catch (error) {
        damaged = error;
      } finally {
        await io(stream, 'close_async', 'close_finish', 0, null).catch(
          () => {},
        );
      }
      let nextDiskId = state.nextId;
      if (damaged) {
        const backup =
          this.directory + '/corrupted-' + GLib.uuid_string_random() + '.log';
        try {
          // Keep every damaged log under a distinct name, then repair only the
          // readable prefix. Never insert diagnostic messages into the clipboard.
          await io(
            this.file,
            'copy_async',
            'copy_finish',
            Gio.File.new_for_path(backup),
            Gio.FileCopyFlags.NONE,
            0,
            null,
            null,
          );
          const recovered = snapshot([...state.archived, ...state.entries]);
          nextDiskId = recovered.length + 1;
          await this.replace(recovered);
          this.report(damaged, backup, true);
        } catch (error) {
          this.readBlocked = true;
          this.report(error);
        }
      }
      await callback(state.entries, state.archived, state.nextId, nextDiskId);
    });
  }

  close() {
    this.options.onError = null;
    return this.enqueue(async () => {
      try {
        if (
          this.needsSnapshot &&
          !this.readBlocked &&
          this.options.currentStateBuilder
        ) {
          await this.replace(snapshot(this.options.currentStateBuilder()));
          this.needsSnapshot = false;
        }
      } finally {
        await this.closeStream();
        this.options.currentStateBuilder = null;
      }
    });
  }
}

export function init(uuid, options = {}) {
  activeStore = new HistoryStore(uuid, options, previousClose);
}

export function destroy() {
  if (activeStore) {
    previousClose = activeStore.close();
    activeStore = null;
  }
  return previousClose;
}

export function buildClipboardStateFromLog(callback) {
  if (typeof callback !== 'function')
    throw new TypeError('callback must be a function');
  return activeStore.read(callback);
}

export function resetDatabase(build, onComplete = null) {
  return activeStore.reset(build, onComplete);
}

export function storeTextEntry(text) {
  return activeStore.append(textRecord(text));
}

export function deleteTextEntry(id) {
  activeStore.wasted += 2;
  return activeStore.append(idRecord(DELETE, id));
}

export function moveEntryToEnd(id) {
  activeStore.wasted++;
  return activeStore.append(idRecord(MOVE, id));
}

export function maybePerformLogCompaction(build) {
  if (activeStore.wasted >= MAX_WASTED_OPS) return activeStore.reset(build);
}
