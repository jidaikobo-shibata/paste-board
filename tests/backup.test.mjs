import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { PasteSets } from '../pasteSets.js';
import { createBackup, parseBackup, importBackup } from '../backup.js';
let checks = 0;
function equal(actual, expected) {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(JSON.stringify(actual) + ' != ' + JSON.stringify(expected));
}
async function rejects(action) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  equal(rejected, true);
}
const schema = Gio.SettingsSchemaSource.new_from_directory(
  GLib.get_current_dir() + '/schemas',
  Gio.SettingsSchemaSource.get_default(),
  false,
).lookup('org.gnome.shell.extensions.paste-board', false);
const settings = () => new Gio.Settings({ settings_schema: schema });
async function main() {
  const source = new PasteSets(
    GLib.dir_make_tmp('paste-board-backup-source.XXXXXX'),
  );
  const id = source.create('Example');
  source.put(id, { name: 'text', text: '\n日本語\nlast\n' });
  source.put(id, {
    kind: 'command',
    name: 'Date',
    command: 'printf sample',
    previewOnOpen: true,
  });
  source.create('Generated', {
    kind: 'generated',
    command: 'printf "one\\ntwo\\n"',
    runOnSearch: true,
  });
  source.renameHistory('My history');
  const original = settings();
  original.set_int('history-size', 1234);
  original.set_strv('toggle-menu', ['<Super>F1']);
  original.set_int('quick-paste-modifiers', 8);
  const json = createBackup(source, original);
  const data = parseBackup(json, original);
  equal(data.historyName, 'My history');
  equal(Object.hasOwn(data, 'history'), false);
  equal(data.sets[0].items[0].text, '\n日本語\nlast\n');
  const target = new PasteSets(
    GLib.dir_make_tmp('paste-board-backup-target.XXXXXX'),
  );
  target.create('Example');
  const destination = settings();
  destination.reset('toggle-menu');
  destination.reset('quick-paste-modifiers');
  destination.set_int('history-size', 2);
  const operation = GLib.uuid_string_random();
  await importBackup(target, destination, json, true, false, operation);
  equal(
    target.data.sets.map((set) => set.name),
    ['Example', 'Example (2)', 'Generated'],
  );
  equal(target.data.sets[1].id === source.data.sets[0].id, false);
  equal(
    target.data.sets[1].items[0].id === source.data.sets[0].items[0].id,
    false,
  );
  equal(target.data.sets[1].items[0].text, data.sets[0].items[0].text);
  equal(target.data.sets[1].items[1].previewOnOpen, false);
  equal(target.data.sets[2].runOnOpen, false);
  equal(target.data.sets[2].runOnSearch, false);
  equal(target.data.historyName, 'My history');
  equal(destination.get_int('history-size'), 1234);
  equal(destination.get_strv('toggle-menu'), []);
  equal(destination.get_int('quick-paste-modifiers'), 0);
  await importBackup(target, destination, json, true, true, operation);
  equal(target.data.sets.length, 3);
  equal(destination.get_strv('toggle-menu'), ['<Super>F1']);
  const reloaded = new PasteSets(GLib.path_get_dirname(target.path));
  await importBackup(reloaded, destination, json, false, false, operation);
  equal(reloaded.data.sets.length, 3);
  const invalid = JSON.parse(json);
  invalid.preferences.unknown = 'true';
  await rejects(() =>
    importBackup(
      target,
      destination,
      JSON.stringify(invalid),
      false,
      false,
      GLib.uuid_string_random(),
    ),
  );
  equal(target.data.sets.length, 3);
  invalid.preferences = { 'history-size': '-1' };
  await rejects(() =>
    importBackup(
      target,
      destination,
      JSON.stringify(invalid),
      true,
      false,
      GLib.uuid_string_random(),
    ),
  );
  equal(target.data.sets.length, 3);
  await rejects(() => parseBackup('{}', original));
  const invalidName = JSON.parse(json);
  invalidName.sets[0].name = 'bad\0name';
  await rejects(() => parseBackup(JSON.stringify(invalidName), original));
  invalidName.sets[0].name = 'valid name';
  invalidName.sets[0].items[0].text = '\ud800';
  await rejects(() => parseBackup(JSON.stringify(invalidName), original));
  const fail = new PasteSets(
    GLib.dir_make_tmp('paste-board-backup-failure.XXXXXX'),
  );
  await fail.flush();
  const write = fail._writeBytes.bind(fail);
  fail._writeBytes = async () => {
    throw Error('disk failure');
  };
  const retryId = GLib.uuid_string_random();
  await rejects(() =>
    importBackup(fail, destination, json, false, false, retryId),
  );
  equal(fail.data.sets.length, 2);
  fail._writeBytes = write;
  await importBackup(fail, destination, json, false, false, retryId);
  equal(fail.data.sets.length, 2);
  equal(new PasteSets(GLib.path_get_dirname(fail.path)).data.sets.length, 2);
  const limited = new PasteSets(
    GLib.dir_make_tmp('paste-board-backup-limited.XXXXXX'),
    { getItemLimit: () => 1 },
  );
  destination.set_int('history-size', 1);
  await rejects(() =>
    importBackup(
      limited,
      destination,
      json,
      false,
      false,
      GLib.uuid_string_random(),
    ),
  );
  equal(limited.data.sets.length, 0);
  await rejects(() =>
    importBackup(
      limited,
      destination,
      json,
      true,
      false,
      GLib.uuid_string_random(),
      () => false,
    ),
  );
  equal(limited.data.sets.length, 0);
  const interrupted = new PasteSets(
    GLib.dir_make_tmp('paste-board-backup-interrupted.XXXXXX'),
  );
  await interrupted.flush();
  let active = true;
  const interruptedWrite = interrupted._writeBytes.bind(interrupted);
  interrupted._writeBytes = async (bytes) => {
    await interruptedWrite(bytes);
    active = false;
  };
  const interruptedId = GLib.uuid_string_random();
  destination.set_int('history-size', 1);
  await rejects(() =>
    importBackup(
      interrupted,
      destination,
      json,
      true,
      false,
      interruptedId,
      () => active,
    ),
  );
  equal(interrupted.data.sets.length, 2);
  equal(destination.get_int('history-size'), 1);
  active = true;
  await importBackup(
    interrupted,
    destination,
    json,
    true,
    false,
    interruptedId,
    () => active,
  );
  equal(interrupted.data.sets.length, 2);
  equal(destination.get_int('history-size'), 1234);
  await interrupted.close();
  await Promise.all([
    source.close(),
    target.close(),
    reloaded.close(),
    fail.close(),
    limited.close(),
  ]);
  print(`Backup import and export: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => (failure = error))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
