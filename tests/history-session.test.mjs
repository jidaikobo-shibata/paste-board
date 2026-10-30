import GLib from 'gi://GLib';
import { HistorySession } from '../historySession.js';
const directory = GLib.dir_make_tmp('clipboard-history-session-XXXXXX');
let count = 0;
function equal(actual, expected) {
  if (actual !== expected)
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  count++;
}
try {
  let session = new HistorySession(directory, 'boot1:login1', false);
  equal(session.discardHistory, false);
  session.setEnabled(true);
  session = new HistorySession(directory, 'boot1:login1', true);
  equal(session.discardHistory, false); // Lock, extension reload, cancelled logout.
  session = new HistorySession(directory, 'boot1:login2', true);
  equal(session.discardHistory, true); // Previous session ended without cleanup.
  session = new HistorySession(directory, 'boot1:login2', true);
  equal(session.discardHistory, true); // Cleanup interrupted before its disk commit.
  session.cleared();
  session = new HistorySession(directory, 'boot1:login2', true);
  equal(session.discardHistory, false);
  session.end();
  session = new HistorySession(directory, 'boot1:login2', true);
  equal(session.discardHistory, true); // Confirmed SessionOver also invalidates identity.
  session.cleared();
  session.setEnabled(false);
  session = new HistorySession(directory, 'boot2:login2', false);
  equal(session.discardHistory, false); // Persistence opted in, even after reboot.
  session.setEnabled(true);
  session = new HistorySession(directory, 'boot3:login2', false);
  equal(session.discardHistory, true); // Honor previous session's policy.

  const path = GLib.build_filenamev([directory, 'history-session.json']);
  for (const enabled of [false, true]) {
    for (const malformed of [
      '{',
      'null',
      '{}',
      '{"sessionId":"old","clearOnLogout":"false","ended":false,"discardPending":false}',
    ]) {
      GLib.file_set_contents(path, malformed);
      session = new HistorySession(directory, 'boot:new-login', enabled);
      equal(session.discardHistory, enabled);
      equal(
        new TextDecoder().decode(
          GLib.file_get_contents(session.recoveredFrom)[1],
        ),
        malformed,
      );
      equal(
        JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]))
          .discardPending,
        enabled,
      );
      GLib.unlink(session.recoveredFrom);
      session.cleared();
      equal(
        new HistorySession(directory, 'boot:new-login', enabled).discardHistory,
        false,
      );
    }
  }

  for (const enabled of [false, true]) {
    const invalid = new Uint8Array([255]);
    GLib.file_set_contents(path, invalid);
    session = new HistorySession(directory, 'boot:utf8-test', enabled);
    equal(session.discardHistory, enabled);
    equal(
      Array.from(GLib.file_get_contents(session.recoveredFrom)[1]).join(','),
      '255',
    );
    GLib.unlink(session.recoveredFrom);
    session.cleared();
    equal(
      new HistorySession(directory, 'boot:utf8-test', enabled).discardHistory,
      false,
    );
  }

  print(`History-session policy: ${count} checks passed`);
} finally {
  GLib.unlink(GLib.build_filenamev([directory, 'history-session.json']));
  GLib.rmdir(directory);
}
