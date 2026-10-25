import GLib from 'gi://GLib';
import {runCommand} from '../commandOutput.js';
import {PasteSets} from '../pasteSets.js';

const loop = GLib.MainLoop.new(null, false);
let failure;
let count = 0;
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
  equal(await runCommand("printf '  first\\nsecond \\n\\n'").promise, '  first\nsecond ');
  equal(await runCommand("printf 'text\\n\\n'", {trimTrailingNewlines: false}).promise, 'text\n\n');
  equal(await runCommand("printf 'a\\r\\n\\r\\n'").promise, 'a');
  equal(await runCommand("printf '%s' '$(date) $HOME * ~ |'").promise, '$(date) $HOME * ~ |');
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
    const store = new PasteSets(directory, [{name: 'legacy', text: 'original'}]);
    const id = store.data.sets[0].id;
    equal(store.data.sets[0].items[0].text, 'original');
    store.put(id, {name: 'date', kind: 'command', command: "date '+%F'"});
    let item = store.data.sets[0].items[1];
    equal(item.trimTrailingNewlines, true);
    const reloaded = new PasteSets(directory);
    equal(reloaded.data.sets[0].items[1].command, "date '+%F'");
    const other = store.create('other');
    store.put(other, {...item, id: undefined});
    equal(store.data.sets[1].items[0].kind, 'command');
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
