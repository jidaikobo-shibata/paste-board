// Optional benchmark using only synthetic sleep/printf commands.
import GLib from 'gi://GLib';
import { CommandPreviews } from '../commandPreviews.js';
import { runCommand } from '../commandOutput.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(0, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
const stats = (values) => {
  values.sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)],
    maxMs: values.at(-1),
  };
};
async function main() {
  const report = [];
  for (const scenario of ['top', 'filtered-tail', 'scroll-to-tail']) {
    const samples = [],
      totals = [];
    let peak = 0,
      executionCount = 0,
      cancelCount = 0;
    for (let sample = 0; sample < 3; sample++) {
      const items = Array.from({ length: 16 }, (_, i) => ({
        id: 'item-' + i,
        kind: 'command',
        command: `sleep ${i < 12 ? '0.10' : '0.005'}; printf synthetic-${i}`,
        executionMode: 'bash',
        trimTrailingNewlines: true,
        previewOnOpen: true,
      }));
      const visible = (
        scenario === 'top' ? items.slice(0, 4) : items.slice(-4)
      ).map((item) => item.id);
      let active = 0;
      const previews = new CommandPreviews(() => {}, {
        execute: (command, options) => {
          executionCount++;
          active++;
          peak = Math.max(peak, active);
          const running = runCommand(command, options);
          return {
            promise: running.promise.finally(() => active--),
            cancel() {
              cancelCount++;
              running.cancel();
            },
          };
        },
      });
      const start = GLib.get_monotonic_time();
      previews.sync(items, {
        priorityIds: scenario === 'scroll-to-tail' ? [] : visible,
      });
      const all = items.map((item) => previews.get(item).promise);
      if (scenario === 'scroll-to-tail') {
        await delay(20);
        previews.prioritize?.(visible);
      }
      await Promise.all(visible.map((id) => previews.records.get(id).promise));
      samples.push((GLib.get_monotonic_time() - start) / 1000);
      await Promise.all(all);
      totals.push((GLib.get_monotonic_time() - start) / 1000);
      if (previews.records.size !== items.length || peak > 2)
        throw Error('Execution target or concurrency changed');
      previews.destroy();
    }
    report.push({
      scenario,
      commands: 16,
      visibleCommands: 4,
      runs: 3,
      visibleReady: stats(samples),
      allReady: stats(totals),
      peakConcurrent: peak,
      executionCount,
      cancelCount,
    });
  }
  print(JSON.stringify(report, null, 2));
}
const loop = GLib.MainLoop.new(null, false);
let failure;
main()
  .catch((error) => (failure = error))
  .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
