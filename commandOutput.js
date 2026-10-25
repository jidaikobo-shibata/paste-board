import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SUPERVISOR = Gio.File.new_for_uri(import.meta.url).get_parent()
  .get_child('commandSupervisor.py').get_path();

// Missing executionMode deliberately retains the original direct-argv behavior.
export function runCommand(command, {trimTrailingNewlines = true, executionMode = 'direct',
  timeoutMs = 3000, maxOutputBytes = 65536} = {}) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let process;
    let timer;
    let settled = false;
    const cancellable = new Gio.Cancellable();
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      if (timer) GLib.Source.remove(timer);
      timer = undefined;
      if (error) {
        // Signal the live session owner, not a recycled numeric process-group ID.
        process?.send_signal(15);
        cancellable.cancel();
        reject(error);
      } else {
        resolve(text);
      }
    };
    cancel = () => finish(new Error('コマンドの実行を中止しました。'));
    try {
      if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0'))
        throw new Error('コマンドを入力してください（8192文字以内）。');
      if (!['direct', 'bash'].includes(executionMode))
        throw new Error('コマンドの実行方式が不正です。');
      const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      });
      let argv;
      if (executionMode === 'bash') {
        for (const name of ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'])
          launcher.unsetenv(name);
        launcher.set_cwd(GLib.get_home_dir());
        argv = ['/bin/bash', '--noprofile', '--norc', '-o', 'pipefail', '-c', command];
      } else {
        [, argv] = GLib.shell_parse_argv(command);
      }
      // Python isolated mode ignores Python startup/import environment hooks.
      process = launcher.spawnv(['/usr/bin/python3', '-I', SUPERVISOR, String(maxOutputBytes), ...argv]);
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timer = undefined;
        finish(new Error('コマンドの実行が時間制限を超えました。'));
        return GLib.SOURCE_REMOVE;
      });
      // Only the trusted supervisor writes here, with bounded JSON-encoded output.
      process.communicate_utf8_async(null, cancellable, (self, result) => {
        try {
          const [, stdout, stderr] = self.communicate_utf8_finish(result);
          if (settled) return;
          const response = JSON.parse(stdout);
          if (response.error) throw new Error(response.error);
          if (!self.get_successful() || typeof response.text !== 'string')
            throw new Error(stderr || 'コマンド監視処理に失敗しました。');
          let text = response.text;
          if (trimTrailingNewlines) text = text.replace(/(?:\r?\n)+$/, '');
          if (!text) throw new Error('コマンドの出力が空のため、貼り付けませんでした。');
          finish(null, text);
        } catch (error) {finish(error);}
      });
    } catch (error) {finish(error);}
  });
  return {promise, cancel: () => cancel()};
}
