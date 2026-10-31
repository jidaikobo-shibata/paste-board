import GLib from 'gi://GLib';
import { _, format } from '../i18n.js';
import { runCommand } from '../commandOutput.js';
import { PasteSets } from '../pasteSets.js';
import { flushSets } from './flush-paste-sets.js';

const japanese = ARGV[0] === 'ja';
let checks = 0;
function equal(actual, expected) {
  if (actual !== expected)
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  checks++;
}
equal(_('History'), japanese ? '履歴' : 'History');
equal(_('Body'), japanese ? '本文' : 'Body');
equal(_('Output'), japanese ? '出力' : 'Output');
equal(
  _('About command execution'),
  japanese ? 'コマンド実行について' : 'About command execution',
);
equal(_('Panel width (%)'), japanese ? 'パネルの幅（%）' : 'Panel width (%)');
equal(
  _('Command execution timed out.'),
  japanese
    ? 'コマンドの実行が時間制限を超えました。'
    : 'Command execution timed out.',
);
equal(format('%2$s %1$s %% %3$d', 'first', 'second', 3), 'second first % 3');
equal(
  format(_('%s+number'), 'Super'),
  japanese ? 'Super+数字' : 'Super+number',
);
const directory = GLib.dir_make_tmp('clipboard-localization-XXXXXX');
try {
  const sets = new PasteSets(directory);
  sets.create('利用者の名前 $HOME');
  flushSets(sets);
  equal(new PasteSets(directory).data.sets[0].name, '利用者の名前 $HOME');
} finally {
  GLib.unlink(GLib.build_filenamev([directory, 'paste-sets.json']));
  GLib.rmdir(directory);
}
const loop = GLib.MainLoop.new(null, false);
let failure;
(async () => {
  equal(
    await runCommand("printf '利用者の文字列\\n'", { executionMode: 'bash' })
      .promise,
    '利用者の文字列',
  );
  try {
    await runCommand('false').promise;
    throw new Error('Unexpected command success');
  } catch (error) {
    equal(error.message, _('The command did not exit successfully.'));
  }
})()
  .catch((error) => {
    failure = error;
  })
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
print(`Localization (${japanese ? 'ja' : 'en'}): ${checks} checks passed`);
