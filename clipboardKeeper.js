// Own a complete, in-memory clipboard snapshot through the Xwayland bridge.
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const loop = new GLib.MainLoop(null, false);
const input = new Gio.DataInputStream({
  base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }),
});
let clipboard;
let original;
let temporary;
let phase = 'snapshot';
let step = 'initialization';
let invalidated = false;
let writing = false;
let timer;
let total = 0;
const cancellable = new Gio.Cancellable();
const LIMIT = 32 * 1024 * 1024;
const emit = status => print(status);

function setProvider(provider) {
  writing = true;
  try {
    if (!clipboard.set_content(provider))
      throw new Error('Clipboard ownership failed');
  } finally {
    writing = false;
  }
}

function restore() {
  if (timer) {
    GLib.Source.remove(timer);
    timer = undefined;
  }
  if (phase !== 'temporary')
    return;
  // Another copy always takes precedence over restoring the old snapshot.
  if (clipboard.get_content() !== temporary) {
    emit('changed');
    loop.quit();
    return;
  }
  setProvider(original);
  phase = 'restored';
  emit('restored');
  // Stay alive as the clipboard owner until another application copies.
}

function readMime(mime) {
  return new Promise((resolve, reject) => {
    clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, cancellable, (obj, result) => {
      let stream;
      let chunks = [];
      let size = 0;
      try {
        [stream] = obj.read_finish(result);
      } catch (error) {
        reject(error);
        return;
      }
      const read = () => stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT,
        cancellable, (src, res) => {
          try {
            const bytes = src.read_bytes_finish(res);
            const count = bytes.get_size();
            if (!count) {
              stream.close(null);
              const data = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.length;
              }
              resolve(Gdk.ContentProvider.new_for_bytes(mime, new GLib.Bytes(data)));
              return;
            }
            size += count;
            total += count;
            if (total > LIMIT)
              throw new Error('Snapshot exceeds memory limit');
            chunks.push(bytes.get_data());
            read();
          } catch (error) {
            try { stream.close(null); } catch {}
            reject(error);
          }
        });
      read();
    });
  });
}

function fail(error) {
  // Do not print clipboard contents, MIME metadata, or exception payloads.
  const reasons = ['No Xwayland display', 'Invalid request',
    'Unsupported clipboard formats', 'Xwayland did not expose every original format',
    'Clipboard changed during snapshot', 'Snapshot exceeds memory limit',
    'Clipboard ownership failed'];
  const reason = reasons.includes(error.message) ? error.message :
    ((['initialization', 'display', 'clipboard', 'read request'].includes(step) || step.startsWith('read format'))
      ? String(error.message || error) : String(error.name || 'I/O error'));
  printerr('Clipboard keeper: operation failed (' + phase + ', ' + step + '): ' + reason);
  emit('error');
  try { restore(); } catch {}
  if (phase !== 'restored')
    loop.quit();
}

function waitCommand() {
  input.read_line_async(GLib.PRIORITY_DEFAULT, null, (obj, result) => {
    try {
      const [line] = obj.read_line_finish_utf8(result);
      if (line === null || line === 'restore') {
        if (phase === 'temporary')
          restore();
        else if (phase !== 'restored')
          loop.quit();
        return;
      }
      if (line.startsWith('{') && phase === 'restored') {
        const request = JSON.parse(line);
        if (typeof request.text !== 'string')
          throw new Error('Invalid request');
        temporary = Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8',
          new GLib.Bytes(new TextEncoder().encode(request.text)));
        phase = 'ready';
        invalidated = false;
        emit('ready');
      }
      if (line === 'paste' && phase === 'ready') {
        if (invalidated) {
          emit('changed');
          loop.quit();
          return;
        }
        setProvider(temporary);
        phase = 'temporary';
        // Give the Xwayland selection bridge time to advertise the text.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 75, () => {
          if (phase === 'temporary')
            emit('prepared');
          return GLib.SOURCE_REMOVE;
        });
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
          timer = undefined;
          restore();
          return GLib.SOURCE_REMOVE;
        });
      }
      waitCommand();
    } catch (error) { fail(error); }
  });
}

async function start() {
  Gtk.init();
  step = 'display';
  const display = Gdk.Display.get_default();
  if (!display)
    throw new Error('No Xwayland display');
  step = 'clipboard';
  clipboard = display.get_clipboard();
  clipboard.connect('changed', () => {
    if (writing)
      return;
    if (phase === 'snapshot' || phase === 'ready')
      invalidated = true;
    else if (phase === 'temporary' && clipboard.get_content() !== temporary) {
      emit('changed');
      loop.quit();
    } else if (phase === 'restored' && clipboard.get_content() !== original) {
      emit('changed');
      loop.quit();
    }
  });
  step = 'read request';
  const [line] = await new Promise((resolve, reject) =>
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
      try { resolve(obj.read_line_finish_utf8(res)); } catch (e) { reject(e); }
    }));
  step = 'request';
  const request = JSON.parse(line);
  const text = request.text;
  if (typeof text !== 'string')
    throw new Error('Invalid request');
  // Allow initial X11 clipboard format discovery to finish.
  await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
  }));
  invalidated = false;
  step = 'formats';
  const mimes = [...new Set(clipboard.get_formats().get_mime_types())];
  if (!mimes.length || mimes.length > 64)
    throw new Error('Unsupported clipboard formats');
  // X11 selection protocol targets are generated by GTK, not copied payloads.
  const aliases = ['STRING', 'TEXT', 'UTF8_STRING', 'COMPOUND_TEXT',
    'TARGETS', 'TIMESTAMP', 'SAVE_TARGETS'];
  const missing = (request.mimes || []).filter(mime =>
    !aliases.includes(mime) && !mimes.includes(mime));
  printerr('Clipboard keeper: formats original=' + request.mimes?.length +
    ' bridge=' + mimes.length + ' missing=' + missing.length);
  if (!Array.isArray(request.mimes) || missing.length) {
    // Log type identifiers only, never clipboard contents.
    printerr('Clipboard keeper: missing MIME types: ' + JSON.stringify(missing));
    throw new Error('Xwayland did not expose every original format');
  }
  const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    cancellable.cancel();
    return GLib.SOURCE_REMOVE;
  });
  const providers = [];
  try {
    for (let i = 0; i < mimes.length; i++) {
      step = 'read format ' + (i + 1) + '/' + mimes.length;
      providers.push(await readMime(mimes[i]));
    }
  } finally {
    if (!cancellable.is_cancelled())
      GLib.Source.remove(timeout);
  }
  if (invalidated)
    throw new Error('Clipboard changed during snapshot');
  step = 'build providers';
  original = Gdk.ContentProvider.new_union(providers);
  temporary = Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8',
    new GLib.Bytes(new TextEncoder().encode(text)));
  phase = 'ready';
  emit('ready');
  waitCommand();
}
start().catch(fail);
loop.run();
