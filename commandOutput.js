import {_} from './i18n.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SUPERVISOR = Gio.File.new_for_uri(import.meta.url).get_parent()
  .get_child('commandSupervisor.py').get_path();

// Direct argument passing is the default; shell interpretation requires explicit Bash mode.
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
    cancel = () => finish(new Error(_("Command execution was cancelled.")));
    try {
      if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0'))
        throw new Error(_("Enter a command (up to 8192 characters)."));
      if (!['direct', 'bash'].includes(executionMode))
        throw new Error(_("Invalid command execution mode."));
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
        finish(new Error(_("Command execution timed out.")));
        return GLib.SOURCE_REMOVE;
      });
      // Only the trusted supervisor writes here, with bounded JSON-encoded output.
      process.communicate_utf8_async(null, cancellable, (self, result) => {
        try {
          const [, stdout, stderr] = self.communicate_utf8_finish(result);
          if (settled) return;
          const response = JSON.parse(stdout);
          if (response.error) {
            const messages = {
              'output-limit': _('Command output exceeded the size limit.'),
              'command-failed': _('The command did not exit successfully.'),
              'nul-output': _('The output contains a NUL character.'),
              'invalid-utf8': _('The output is not valid UTF-8 text.'),
              'launch-failed': _('Could not start the command.'),
              'supervisor-failed': _('Command supervision failed.'),
            };
            const message = messages[response.error] || _('Command supervision failed.');
            throw new Error(message + (response.detail ? '\n' + response.detail : ''));
          }
          if (!self.get_successful() || typeof response.text !== 'string')
            throw new Error(stderr || _("Command supervision failed."));
          let text = response.text;
          if (trimTrailingNewlines) text = text.replace(/(?:\r?\n)+$/, '');
          if (!text) throw new Error(_("The command produced no output; nothing was pasted."));
          finish(null, text);
        } catch (error) {finish(error);}
      });
    } catch (error) {finish(error);}
  });
  return {promise, cancel: () => cancel()};
}
