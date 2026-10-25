import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Execute argv directly. No shell expansion or automatic execution on display.
export function runCommand(command, {trimTrailingNewlines = true,
  timeoutMs = 3000, maxOutputBytes = 65536} = {}) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let process;
    let timer;
    let settled = false;
    let exited = false;
    let streamsLeft = 2;
    let totalBytes = 0;
    const cancellable = new Gio.Cancellable();
    const stdout = [];
    const stderr = [];
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      if (timer) GLib.Source.remove(timer);
      timer = undefined;
      if (error) {
        if (!exited) process?.force_exit();
        cancellable.cancel();
        reject(error);
      } else {
        resolve(text);
      }
    };
    cancel = () => finish(new Error('コマンドの実行を中止しました。'));
    const decode = chunks => {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    };
    const complete = () => {
      if (settled || !exited || streamsLeft) return;
      try {
        if (!process.get_successful()) {
          const detail = decode(stderr).slice(0, 300);
          throw new Error(`コマンドが正常に終了しませんでした。${detail ? '\n' + detail : ''}`);
        }
        let text = decode(stdout);
        if (text.includes('\0')) throw new Error('出力にNUL文字が含まれています。');
        if (trimTrailingNewlines) text = text.replace(/(?:\r?\n)+$/, '');
        if (!text) throw new Error('コマンドの出力が空のため、貼り付けませんでした。');
        finish(null, text);
      } catch (error) {finish(error);}
    };
    const read = (stream, chunks) => {
      stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (self, result) => {
        try {
          const bytes = self.read_bytes_finish(result);
          if (settled) {self.close(null); return;}
          if (!bytes.get_size()) {
            self.close(null);
            streamsLeft--;
            complete();
            return;
          }
          totalBytes += bytes.get_size();
          if (totalBytes > maxOutputBytes) {
            self.close(null);
            finish(new Error('コマンドの出力量が上限を超えました。'));
            return;
          }
          chunks.push(bytes.toArray());
          read(self, chunks);
        } catch (error) {
          try {self.close(null);} catch {}
          finish(error);
        }
      });
    };
    try {
      if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0'))
        throw new Error('コマンドを入力してください（8192文字以内）。');
      const [, argv] = GLib.shell_parse_argv(command);
      // The default stdin is /dev/null, so commands cannot wait for keyboard input.
      process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timer = undefined;
        finish(new Error('コマンドの実行が時間制限を超えました。'));
        return GLib.SOURCE_REMOVE;
      });
      read(process.get_stdout_pipe(), stdout);
      read(process.get_stderr_pipe(), stderr);
      process.wait_async(null, (self, result) => {
        try {self.wait_finish(result); exited = true; complete();}
        catch (error) {finish(error);}
      });
    } catch (error) {finish(error);}
  });
  return {promise, cancel: () => cancel()};
}
