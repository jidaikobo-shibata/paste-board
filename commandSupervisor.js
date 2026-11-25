#!@GJS@ -m
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

function stopGroup() {
  // Zero addresses our current group, which remains owned until we exit.
  GLib.spawn_sync(null, ['/usr/bin/kill', '-KILL', '--', '0'], null, 0, null);
}

async function supervise(limit, argv) {
  // Refuse standalone invocation unless setsid made us the session leader.
  const stat = new TextDecoder().decode(
    GLib.file_get_contents('/proc/self/stat')[1],
  );
  const pid = stat.slice(0, stat.indexOf(' '));
  const [, , group, session] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (
    group !== pid ||
    session !== pid ||
    !GLib.file_test('/usr/bin/kill', GLib.FileTest.IS_EXECUTABLE)
  )
    throw Error('supervisor-failed');
  if (!Number.isSafeInteger(limit) || limit <= 0 || !argv.length)
    throw Error('supervisor-failed');
  GLibUnix.signal_add(GLib.PRIORITY_HIGH, 15, () => {
    stopGroup();
    return GLib.SOURCE_REMOVE;
  });
  let child;
  try {
    child = Gio.Subprocess.new(
      argv,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );
  } catch {
    throw Error('launch-failed');
  }
  let total = 0;
  const chunks = [];
  let stdoutSize = 0;
  async function drain(stream, keep) {
    while (true) {
      const bytes = await stream.read_bytes_async(
        4096,
        GLib.PRIORITY_DEFAULT,
        null,
      );
      const size = bytes.get_size();
      if (!size) return;
      total += size;
      if (total > limit) throw Error('output-limit');
      if (keep) {
        chunks.push(bytes.toArray());
        stdoutSize += size;
      }
    }
  }
  try {
    await Promise.all([
      drain(child.get_stdout_pipe(), true),
      drain(child.get_stderr_pipe(), false),
      child.wait_async(null),
    ]);
    if (!child.get_successful()) throw Error('command-failed');
    const output = new Uint8Array(stdoutSize);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    if (output.includes(0)) throw Error('nul-output');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        output,
      );
    } catch {
      throw Error('invalid-utf8');
    }
    print(JSON.stringify({ text }));
  } catch (error) {
    print(JSON.stringify({ error: error.message }));
    stopGroup();
  }
}

try {
  await supervise(Number(ARGV[0]), ARGV.slice(1));
} catch (error) {
  print(JSON.stringify({ error: error.message }));
}
