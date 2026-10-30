import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { textFitsLimit, readBoundedFile } from '../inputLimits.js';
import { PasteSets } from '../pasteSets.js';
import { HistorySession } from '../historySession.js';
let checks = 0;
function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${a} != ${b}`);
  checks++;
}
function rejects(action) {
  let caught = false;
  try {
    action();
  } catch {
    caught = true;
  }
  equal(caught, true);
}
for (const text of ['', 'abc', '日本語', 'é', '😀', '\ud800', 'a😀b']) {
  const bytes = new TextEncoder().encode(text).length;
  equal(textFitsLimit(text, bytes), true);
  if (bytes) equal(textFitsLimit(text, bytes - 1), false);
}
equal(textFitsLimit(null), false);
const directory = GLib.dir_make_tmp('paste-board-bounded-read.XXXXXX');
try {
  const path = directory + '/sample';
  const text = 'a'.repeat(65535) + '日本語';
  const encoded = new TextEncoder().encode(text);
  GLib.file_set_contents(path, encoded);
  equal(Array.from(readBoundedFile(path, encoded.length)), Array.from(encoded));
  rejects(() => readBoundedFile(path, encoded.length - 1));
  GLib.file_set_contents(path, '');
  equal(readBoundedFile(path, 0).length, 0);
  GLib.unlink(path);
  // A sparse oversized file is rejected without reading its contents into memory.
  const io = Gio.File.new_for_path(
    directory + '/paste-sets.json',
  ).create_readwrite(Gio.FileCreateFlags.PRIVATE, null);
  io.truncate(16 * 1024 * 1024 + 1, null);
  io.close(null);
  rejects(() => new PasteSets(directory));
  GLib.unlink(directory + '/paste-sets.json');
  GLib.file_set_contents(
    directory + '/history-session.json',
    ' '.repeat(65537),
  );
  const session = new HistorySession(directory, 'audit-session', true);
  equal(session.discardHistory, true);
  equal(GLib.file_get_contents(session.recoveredFrom)[1].length, 65537);
  GLib.unlink(session.recoveredFrom);
  GLib.unlink(directory + '/history-session.json');
} finally {
  GLib.rmdir(directory);
}
print(`Input limits: ${checks} checks passed`);
