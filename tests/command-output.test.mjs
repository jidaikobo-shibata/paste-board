import GLib from 'gi://GLib';
import {runCommand as executeCommand} from '../commandOutput.js';
import {PasteSets} from '../pasteSets.js';

const loop = GLib.MainLoop.new(null, false);
let failure;
let count = 0;
const runCommand = (command, options = {}) => executeCommand(command, {executionMode: 'bash', ...options});
function equal(actual, expected) {
  if (actual !== expected) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  count++;
}
async function rejects(command, options, expected) {
  try {await runCommand(command, options).promise;}
  catch (error) {
    if (expected && !error.message.includes(expected)) throw error;
    count++;
    return;
  }
  throw new Error(`Unexpected success: ${command}`);
}
async function main() {
  equal(await executeCommand("printf '%s' $HOME").promise, '$HOME');
  equal(await executeCommand("printf '%s' 'a | b'").promise, 'a | b');
  equal(await runCommand("printf '  first\\nsecond \\n\\n'").promise, '  first\nsecond ');
  equal(await runCommand("printf 'text\\n\\n'", {trimTrailingNewlines: false}).promise, 'text\n\n');
  equal(await runCommand("printf 'a\\r\\n\\r\\n'").promise, 'a');
  equal(await runCommand("printf '%s' '$(date) $HOME * ~ |'").promise, '$(date) $HOME * ~ |');
  equal(await runCommand("value='hello world'; printf '%s' \"$value\" | tr '[:lower:]' '[:upper:]'").promise,
    'HELLO WORLD');
  equal(await runCommand('value=$(printf generated); printf "%s" "$value"').promise, 'generated');
  equal(await runCommand('printf "%s" "$HOME"').promise, GLib.get_home_dir());
  equal(await runCommand('pwd').promise, GLib.get_home_dir());
  equal(await runCommand('printf "%s" "$((7 * 6))"').promise, '42');
  equal(await runCommand("cat <<'TEXT'\n$HOME stays literal\nTEXT").promise, '$HOME stays literal');
  equal(await runCommand('read answer; printf "%s" "${answer:-no-input}"').promise, 'no-input');
  await rejects('false | printf partial', {}, '正常に終了');
  await rejects('read answer', {}, '正常に終了');
  equal(await runCommand("printf '日本語'").promise, '日本語');
  equal(/^\d{4}-\d{2}-\d{2}$/.test(await runCommand("date '+%Y-%m-%d'").promise), true);
  await rejects('no-such-clipboard-test-command-4f70');
  await rejects('false', {}, '正常に終了');
  await rejects("sh -c 'printf failure >&2; exit 2'", {}, 'failure');
  await rejects('true', {}, '空');
  await rejects('sleep 2', {timeoutMs: 40}, '時間制限');
  await rejects('yes', {maxOutputBytes: 8192}, '上限');
  await rejects("sh -c 'yes >&2'", {maxOutputBytes: 8192}, '上限');
  await rejects("printf '\\000'", {}, 'NUL');
  await rejects("printf '\\377'");
  await rejects('   ');
  await rejects("printf 'unterminated");
  const pending = runCommand('sleep 2');
  pending.cancel();
  try {await pending.promise; throw new Error('Cancellation did not reject');}
  catch (error) {equal(error.message.includes('中止'), true);}

  const directory = GLib.dir_make_tmp('clipboard-command-store-XXXXXX');
  try {
    const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve(); return GLib.SOURCE_REMOVE;
    }));
    for (const scenario of ['timeout', 'cancel', 'leader-exit', 'output-limit']) {
      const marker = GLib.build_filenamev([directory, 'late-' + scenario]);
      const command = scenario === 'leader-exit'
        ? `(sleep 0.3; printf late > '${marker}') & exit 0`
        : scenario === 'output-limit'
          ? `(sleep 0.3; printf late > '${marker}') & yes`
          : `printf harmless | (sleep 0.3; cat > '${marker}')`;
      const task = runCommand(command, {timeoutMs: 100, maxOutputBytes: 8192});
      // Attach the rejection handler before waiting to cancel.
      const result = task.promise.then(() => false, () => true);
      if (scenario === 'cancel') {await delay(60); task.cancel();}
      equal(await result, true);
      await delay(400);
      equal(GLib.file_test(marker, GLib.FileTest.EXISTS), false);
      if (GLib.file_test(marker, GLib.FileTest.EXISTS)) GLib.unlink(marker);
    }
    const startupFile = GLib.build_filenamev([directory, 'startup.sh']);
    GLib.file_set_contents(startupFile, "printf 'UNEXPECTED_STARTUP'");
    const previousEnv = GLib.getenv('BASH_ENV');
    try {
      GLib.setenv('BASH_ENV', startupFile, true);
      equal(await runCommand('printf clean-start').promise, 'clean-start');
    } finally {
      if (previousEnv === null) GLib.unsetenv('BASH_ENV');
      else GLib.setenv('BASH_ENV', previousEnv, true);
      GLib.unlink(startupFile);
    }
    const store = new PasteSets(directory, [{name: 'legacy', text: 'original'}]);
    const id = store.data.sets[0].id;
    equal(store.data.sets[0].items[0].text, 'original');
    store.put(id, {name: 'date', kind: 'command', command: "date '+%F'"});
    let item = store.data.sets[0].items[1];
    equal(item.trimTrailingNewlines, true);
    equal(item.executionMode, 'direct');
    // Simulate a file written before executionMode existed.
    delete store.data.sets[0].items[1].executionMode;
    store.data.sets[0].items[1].command = "printf '%s' $HOME";
    GLib.file_set_contents(store.path, JSON.stringify(store.data));
    const reloaded = new PasteSets(directory);
    const legacy = reloaded.data.sets[0].items[1];
    equal(await executeCommand(legacy.command, {executionMode: legacy.executionMode || 'direct'}).promise, '$HOME');
    const marker = GLib.build_filenamev([directory, 'must-not-execute']);
    const complex = `value=$(printf test); printf '%s' "$value" > '${marker}'`;
    store.put(id, {...item, command: complex, executionMode: 'bash'});
    equal(new PasteSets(directory).data.sets[0].items[1].command, complex);
    equal(new PasteSets(directory).data.sets[0].items[1].executionMode, 'bash');
    equal(GLib.file_test(marker, GLib.FileTest.EXISTS), false);
    const other = store.create('other');
    store.put(other, {...store.data.sets[0].items[1], id: undefined});
    equal(store.data.sets[1].items[0].kind, 'command');
    equal(store.data.sets[1].items[0].executionMode, 'bash');
    equal(store.data.sets[1].items[0].id === item.id, false);
    store.moveRelative(id, item.id, store.data.sets[0].items[0].id, false);
    equal(store.data.sets[0].items[0].kind, 'command');
    item = store.data.sets[0].items[0];
    store.put(id, {id: item.id, name: 'plain again', text: 'literal'});
    equal(store.data.sets[0].items[0].kind, 'text');
    equal(store.data.sets[0].items[0].command, undefined);
    let rejected = false;
    try {store.put(id, {name: 'invalid', kind: 'command', command: ''});}
    catch {rejected = true;}
    equal(rejected, true);
    equal(store.data.sets[0].items.length, 2);
  } finally {
    GLib.unlink(GLib.build_filenamev([directory, 'paste-sets.json']));
    GLib.rmdir(directory);
  }
  print(`Command execution and persistence: ${count} checks passed`);
}
main().catch(error => {failure = error;}).finally(() => loop.quit());
loop.run();
if (failure) throw failure;
