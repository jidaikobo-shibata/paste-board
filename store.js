import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as DS from './dataStructures.js';
import { _ } from './i18n.js';

let EXTENSION_UUID;
let CACHE_DIR;
/**
 * Stores our compacting log implementation. Here are its key ideas:
 * - We only ever append to the log.
 * - This means there will be operations that cancel each other out. These are wasted/useless ops
 *   that must be occasionally pruned. MAX_WASTED_OPS limits the number of useless ops.
 * - The available operations are listed in the OP_TYPE_* constants.
 * - An add op never moves (until compaction), allowing us to derive globally unique entry IDs based
 *   on the order in which these add ops are discovered.
 */
let DATABASE_FILE;
const BYTE_ORDER = Gio.DataStreamByteOrder.LITTLE_ENDIAN;

// Don't use zero b/c DataInputStream uses 0 as its error value
const OP_TYPE_SAVE_TEXT = 1;
const OP_TYPE_DELETE_TEXT = 2;
// Record numbers are stable: existing logs keep their archived text and IDs.
const OP_TYPE_ARCHIVE_ENTRY = 3;
const OP_TYPE_RESTORE_ENTRY = 4;
const OP_TYPE_MOVE_ITEM_TO_END = 5;

const MAX_WASTED_OPS = 500;
let uselessOpCount;

let opQueue = new DS.LinkedList();
let opInProgress = false;
let writeStream;

export function init(uuid) {
  EXTENSION_UUID = uuid;
  CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), EXTENSION_UUID]);
  DATABASE_FILE = GLib.build_filenamev([CACHE_DIR, 'database.log']);
  if (GLib.mkdir_with_parents(CACHE_DIR, 0o775) !== 0) {
    console.log(
      EXTENSION_UUID,
      "Failed to create cache dir, extension likely won't work",
      CACHE_DIR,
    );
  }
}

export function destroy() {
  _pushToOpQueue((resolve) => {
    if (writeStream) {
      writeStream.close_async(0, null, (src, res) => {
        src.close_finish(res);
        resolve();
      });
      writeStream = undefined;
    } else {
      resolve();
    }
  });
}

export function buildClipboardStateFromLog(callback) {
  if (typeof callback !== 'function') {
    throw TypeError('`callback` must be a function');
  }
  uselessOpCount = 0;

  Gio.File.new_for_path(DATABASE_FILE).read_async(0, null, (src, res) => {
    try {
      _parseLog(src.read_finish(res), callback);
    } catch (e) {
      if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
        callback(new DS.LinkedList(), new DS.LinkedList(), 1);
      } else {
        throw e;
      }
    }
  });
}

function _parseLog(stream, callback) {
  stream = Gio.DataInputStream.new(stream);
  stream.set_byte_order(BYTE_ORDER);

  const state = {
    entries: new DS.LinkedList(),
    archivedEntries: new DS.LinkedList(),
    nextId: 1,
  };
  _consumeStream(stream, state, callback);
}

function _consumeStream(stream, state, callback) {
  const finish = () => {
    callback(state.entries, state.archivedEntries, state.nextId);
  };
  const forceFill = (minBytes, fillCallback) => {
    stream.fill_async(/*count=*/ -1, 0, null, (src, res) => {
      if (src.fill_finish(res) < minBytes) {
        finish();
      } else {
        fillCallback();
      }
    });
  };

  let parseAvailableAware;

  function loop() {
    if (stream.get_available() === 0) {
      forceFill(1, loop);
      return;
    }

    const opType = stream.read_byte(null);
    if (opType === OP_TYPE_SAVE_TEXT) {
      stream.read_upto_async(
        /*stop_chars=*/ '\0',
        /*stop_chars_len=*/ 1,
        0,
        null,
        (src, res) => {
          const [text] = src.read_upto_finish(res);
          src.read_byte(null);

          const node = new DS.LLNode();
          node.diskId = node.id = state.nextId++;
          node.type = DS.TYPE_TEXT;
          node.text = text || '';
          node.archived = false;
          state.entries.append(node);

          loop();
        },
      );
    } else if (opType === OP_TYPE_DELETE_TEXT) {
      uselessOpCount += 2;
      parseAvailableAware(4, () => {
        const id = stream.read_uint32(null);
        (
          state.entries.findById(id) || state.archivedEntries.findById(id)
        ).detach();
      });
    } else if (opType === OP_TYPE_ARCHIVE_ENTRY) {
      parseAvailableAware(4, () => {
        const id = stream.read_uint32(null);
        const entry = state.entries.findById(id);

        entry.archived = true;
        state.archivedEntries.append(entry);
      });
    } else if (opType === OP_TYPE_RESTORE_ENTRY) {
      uselessOpCount += 2;
      parseAvailableAware(4, () => {
        const id = stream.read_uint32(null);
        const entry = state.archivedEntries.findById(id);

        entry.archived = false;
        state.entries.append(entry);
      });
    } else if (opType === OP_TYPE_MOVE_ITEM_TO_END) {
      uselessOpCount++;
      parseAvailableAware(4, () => {
        const id = stream.read_uint32(null);
        const entry =
          state.entries.findById(id) || state.archivedEntries.findById(id);

        if (entry.archived) {
          state.archivedEntries.append(entry);
        } else {
          state.entries.append(entry);
        }
      });
    } else {
      console.log(EXTENSION_UUID, 'Unknown op type, aborting load.', opType);
      finish();
    }
  }

  parseAvailableAware = (minBytes, parse) => {
    const safeParse = (cont) => {
      try {
        parse();
        cont();
      } catch (e) {
        console.log(EXTENSION_UUID, 'Parsing error');
        console.error(e);

        const entries = new DS.LinkedList();
        let nextId = 1;
        const addEntry = (text) => {
          const node = new DS.LLNode();
          node.id = nextId++;
          node.type = DS.TYPE_TEXT;
          node.text = text;
          node.archived = false;
          entries.prepend(node);
        };

        addEntry(_('Your clipboard data has been corrupted and was moved to:'));
        addEntry(GLib.build_filenamev([CACHE_DIR, 'corrupted.log']));

        try {
          if (
            !Gio.File.new_for_path(DATABASE_FILE).move(
              Gio.File.new_for_path(
                GLib.build_filenamev([CACHE_DIR, 'corrupted.log']),
              ),
              Gio.FileCopyFlags.OVERWRITE,
              null,
              null,
            )
          ) {
            console.log(EXTENSION_UUID, 'Failed to move database file');
          }
        } catch (e) {
          console.log(EXTENSION_UUID, 'Crash moving database file');
          console.error(e);
        }
        callback(entries, new DS.LinkedList(), nextId, 1);
      }
    };

    if (stream.get_available() < minBytes) {
      forceFill(minBytes, () => {
        safeParse(loop);
      });
    } else {
      safeParse(loop);
    }
  };

  loop();
}

export function maybePerformLogCompaction(currentStateBuilder) {
  if (uselessOpCount >= MAX_WASTED_OPS) {
    resetDatabase(currentStateBuilder);
  }
}

export function resetDatabase(currentStateBuilder, onComplete = null) {
  uselessOpCount = 0;

  const state = currentStateBuilder();
  _pushToOpQueue((resolve) => {
    // Sigh, can't use truncate because it doesn't have an async variant. Instead, nuke the stream
    // and let the next append re-create it. Note that we can't use this stream because it tries to
    // apply our operations atomically and therefore writes to a temporary file instead of the one
    // we asked for.
    writeStream = undefined;

    const priority = -10;
    Gio.File.new_for_path(DATABASE_FILE).replace_async(
      /*etag=*/ null,
      /*make_backup=*/ false,
      Gio.FileCreateFlags.PRIVATE,
      priority,
      null,
      (src, res) => {
        const stream = _createBufferedDataStream(src.replace_finish(res));
        const finish = () => {
          stream.close_async(priority, null, (src, res) => {
            src.close_finish(res);
            resolve();
            onComplete?.();
          });
        };

        if (state.length === 0) {
          finish();
          return;
        }

        let i = 0;
        _writeToStream(stream, priority, finish, (dataStream) => {
          do {
            const entry = state[i];

            if (entry.type === DS.TYPE_TEXT) {
              _storeTextOp(entry.text)(dataStream);
            } else {
              throw new TypeError('Unknown type: ' + entry.type);
            }
            if (entry.archived) {
              _archiveEntryOp(entry.diskId)(dataStream);
            }

            i++;
          } while (i % 1000 !== 0 && i < state.length);

          // Flush the buffer every 1000 entries
          return i >= state.length;
        });
      },
    );
  });
}

export function storeTextEntry(text) {
  _appendBytesToLog(_storeTextOp(text), -5);
}

function _storeTextOp(text) {
  return (dataStream) => {
    dataStream.put_byte(OP_TYPE_SAVE_TEXT, null);
    dataStream.put_string(text, null);
    dataStream.put_byte(0, null); // NUL terminator
    return true;
  };
}

export function deleteTextEntry(id) {
  _appendBytesToLog(_deleteTextOp(id), 5);
  uselessOpCount += 2;
}

function _deleteTextOp(id) {
  return (dataStream) => {
    dataStream.put_byte(OP_TYPE_DELETE_TEXT, null);
    dataStream.put_uint32(id, null);
    return true;
  };
}

// Archived records remain part of the on-disk log, without a separate user interface.
function _archiveEntryOp(id) {
  return (dataStream) => {
    dataStream.put_byte(OP_TYPE_ARCHIVE_ENTRY, null);
    dataStream.put_uint32(id, null);
    return true;
  };
}

export function moveEntryToEnd(id) {
  _appendBytesToLog(_moveToEndOp(id));
  uselessOpCount++;
}

function _moveToEndOp(id) {
  return (dataStream) => {
    dataStream.put_byte(OP_TYPE_MOVE_ITEM_TO_END, null);
    dataStream.put_uint32(id, null);
    return true;
  };
}

function _appendBytesToLog(callback, priority) {
  priority = priority || 0;
  _pushToOpQueue((resolve) => {
    const runUnsafe = () => {
      _writeToStream(writeStream, priority, resolve, callback);
    };

    if (writeStream === undefined) {
      Gio.File.new_for_path(DATABASE_FILE).append_to_async(
        Gio.FileCreateFlags.PRIVATE,
        priority,
        null,
        (src, res) => {
          writeStream = _createBufferedDataStream(src.append_to_finish(res));
          runUnsafe();
        },
      );
    } else {
      runUnsafe();
    }
  });
}

function _writeToStream(stream, priority, resolve, callback) {
  _writeBufferedBatch(callback, stream, priority, () => {
    stream.flush_async(priority, null, (src, res) => {
      src.flush_finish(res);
      resolve();
    });
  });
}

/**
 * DataOutputStream only offers synchronous encoding methods. Encode into an auto-growing
 * memory buffer and flush completed batches asynchronously, keeping disk I/O off the Shell thread.
 */
function _writeBufferedBatch(dataCallback, stream, priority, callback) {
  if (dataCallback(stream)) {
    callback();
  } else {
    stream.flush_async(priority, null, (src, res) => {
      src.flush_finish(res);
      _writeBufferedBatch(dataCallback, stream, priority, callback);
    });
  }
}

function _createBufferedDataStream(stream) {
  const bufStream = Gio.BufferedOutputStream.new(stream);
  bufStream.set_auto_grow(true); // Blocks flushing, needed for hack
  const ioStream = Gio.DataOutputStream.new(bufStream);
  ioStream.set_byte_order(BYTE_ORDER);
  return ioStream;
}

function _pushToOpQueue(op) {
  const consumeOp = () => {
    const resolve = () => {
      opInProgress = false;

      const next = opQueue.head;
      if (next) {
        next.detach();
        next.op();
      }
    };

    opInProgress = true;
    op(resolve);
  };

  if (opInProgress) {
    const node = new DS.LLNode();
    node.op = consumeOp;
    opQueue.append(node);
  } else {
    consumeOp();
  }
}
