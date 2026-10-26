import GLib from 'gi://GLib';
import {HistorySession} from '../historySession.js';
import {migrateSettings} from '../settingsFields.js';
const directory = GLib.dir_make_tmp('clipboard-history-session-XXXXXX');
let count = 0;
function equal(actual, expected) {
  if (actual !== expected) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
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

  const values = new Map([['cache-only-favorites', true], ['notify-on-copy', false]]);
  const settings = {get_user_value: key => values.has(key) ? values.get(key) : null,
    get_boolean: key => values.get(key) ?? false,
    set_boolean: (key, value) => values.set(key, value), set_int: (key, value) => values.set(key, value)};
  migrateSettings(settings);
  equal(values.get('clear-history-on-logout'), true);
  equal(values.get('cache-only-favorites'), false);
  equal(values.get('copy-feedback'), 0);
  values.set('copy-feedback', 4);
  values.set('clear-history-on-logout', false);
  migrateSettings(settings);
  equal(values.get('copy-feedback'), 4);
  equal(values.get('clear-history-on-logout'), false);
  print(`History-session policy and settings migration: ${count} checks passed`);
} finally {
  GLib.unlink(GLib.build_filenamev([directory, 'history-session.json']));
  GLib.rmdir(directory);
}
