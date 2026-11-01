import GLib from 'gi://GLib';
import { GeneratedTabs, generatedItems } from '../generatedTabs.js';
import { PasteSets } from '../pasteSets.js';
import { runCommand } from '../commandOutput.js';

let checks = 0;
const equal = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  checks++;
};
const throws = (fn) => {
  let failed = false;
  try {
    fn();
  } catch {
    failed = true;
  }
  equal(failed, true);
};
const tick = () =>
  new Promise((resolve) =>
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
async function main() {
  equal(
    generatedItems('one\r\n\n two \n\t\nlast\n', 'tab').map((i) => i.text),
    ['one', ' two ', '\t', 'last'],
  );
  equal(generatedItems('', 'tab'), []);
  equal(generatedItems('\n\r\n', 'tab'), []);
  equal(
    generatedItems('x\nx\n', 'tab').map((i) => i.id),
    ['tab:generated:0', 'tab:generated:1'],
  );
  throws(() => generatedItems('x\n'.repeat(1001), 'tab'));
  equal(generatedItems('x\n'.repeat(1000), 'tab').length, 1000);
  const calls = [];
  let notifications = 0;
  const execute = (command, options) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const running = {
      command,
      options,
      promise,
      resolve,
      reject,
      cancelled: false,
      cancel() {
        this.cancelled = true;
        reject(Error('cancelled'));
      },
    };
    calls.push(running);
    return running;
  };
  const tabs = new GeneratedTabs(() => notifications++, { execute });
  const tab = {
    id: 'a',
    kind: 'generated',
    command: 'first',
    executionMode: 'bash',
    items: [],
  };
  const searchCalls = [];
  const searchTabs = new GeneratedTabs(null, {
    execute: (command, options) => {
      const run = execute(command, options);
      searchCalls.push(run);
      return run;
    },
  });
  const opted = { ...tab, runOnSearch: true };
  const second = { ...opted, id: 'b', command: 'second' };
  searchTabs.search([tab], true);
  await tick();
  equal(searchCalls.length, 0);
  searchTabs.endSearch();
  searchTabs.search([opted, second], false);
  await tick();
  equal(searchCalls.length, 0);
  searchTabs.search([opted, second], true);
  await tick();
  equal(searchCalls.length, 1);
  searchTabs.search([opted, second], true);
  await tick();
  equal(searchCalls.length, 1);
  searchCalls[0].resolve('current file');
  await tick();
  equal(searchCalls.length, 2);
  equal(searchTabs.get(opted).items[0].text, 'current file');
  searchCalls[1].resolve('second file');
  await tick();
  searchTabs.endSearch();
  searchTabs.search([opted, second], true);
  await tick();
  equal(searchCalls.length, 3);
  searchTabs.clear();
  await tick();
  equal(searchCalls[2].cancelled, true);
  equal(searchCalls.length, 3);
  equal(searchTabs.records.size, 0);
  // Failure must not block later tabs; disabling scope cancels pending work.
  searchTabs.search([opted, second], true);
  await tick();
  searchCalls[3].reject(Error('failure'));
  await tick();
  equal(searchTabs.get(opted).state, 'error');
  equal(searchCalls.length, 5);
  searchTabs.search([], false);
  await tick();
  equal(searchCalls[4].cancelled, true);
  searchTabs.destroy();
  calls.length = 0;
  let record = tabs.sync(tab, { autoRun: false });
  equal(record.state, 'idle');
  await tick();
  equal(calls.length, 0);
  tabs.refresh(tab);
  await tick();
  equal(calls.length, 1);
  equal(tabs.record.state, 'pending');
  equal(tabs.record.items, []);
  equal(calls[0].options, {
    executionMode: 'bash',
    trimTrailingNewlines: false,
    allowEmptyOutput: true,
  });
  calls[0].resolve('first\n second \n');
  await tick();
  equal(
    tabs.record.items.map((i) => i.text),
    ['first', ' second '],
  );
  equal(notifications, 1);
  record = tabs.record;
  tabs.sync({ ...tab, name: 'renamed' });
  equal(tabs.record === record, true);
  equal(calls.length, 1);
  tabs.refresh(tab);
  await tick();
  equal(calls.length, 2);
  equal(tabs.record.items, []);
  tabs.refresh(tab);
  await tick();
  equal(calls[1].cancelled, true);
  calls[1].resolve('must not return');
  calls[2].resolve('latest');
  await tick();
  equal(
    tabs.record.items.map((i) => i.text),
    ['latest'],
  );
  tabs.refresh(tab);
  await tick();
  const stopped = calls.at(-1);
  tabs.stop();
  await tick();
  equal(stopped.cancelled, true);
  equal(tabs.record.state, 'stopped');
  tabs.sync(tab);
  await tick();
  equal(calls.at(-1) === stopped, true);
  tabs.refresh(tab);
  await tick();
  calls.at(-1).reject(Error('failure'));
  await tick();
  equal(tabs.record.state, 'error');
  equal(tabs.record.items, []);
  tabs.sync(tab);
  await tick();
  equal(tabs.record.state, 'error');
  tabs.refresh(tab);
  await tick();
  calls.at(-1).resolve('x\n'.repeat(1001));
  await tick();
  equal(tabs.record.state, 'error');
  equal(tabs.record.items, []);
  tabs.refresh(tab);
  await tick();
  const cleared = calls.at(-1);
  const oldNotifications = notifications;
  tabs.clear();
  await tick();
  equal(cleared.cancelled, true);
  equal(tabs.record, null);
  equal(notifications, oldNotifications);
  tabs.sync({ ...tab, id: 'b', command: 'other' });
  await tick();
  calls.at(-1).resolve('');
  await tick();
  equal(tabs.record.state, 'ready');
  equal(tabs.record.items, []);
  tabs.sync({ ...tab, id: 'b', command: 'changed' });
  await tick();
  equal(calls.at(-1).command, 'changed');
  tabs.destroy();
  await tick();
  equal(calls.at(-1).cancelled, true);
  equal(tabs.record, null);
  const resumeCalls = [];
  const resume = new GeneratedTabs(null, {
    execute: (command, options) => {
      resumeCalls.push(command);
      return { promise: Promise.resolve('resumed'), cancel() {} };
    },
  });
  resume.sync(tab, { autoRun: false });
  await tick();
  equal(resumeCalls.length, 0);
  resume.sync(tab, { autoRun: true });
  await tick();
  equal(resumeCalls.length, 1);
  equal(resume.record.state, 'ready');
  resume.sync(tab);
  await tick();
  equal(resumeCalls.length, 1);
  resume.destroy();
  const multi = new GeneratedTabs(null, { execute });
  const firstTab = { ...tab, id: 'first' };
  const secondTab = { ...tab, id: 'second' };
  multi.sync(firstTab);
  await tick();
  calls.at(-1).resolve('kept first');
  await tick();
  const cachedFirst = multi.record;
  multi.suspend();
  equal(multi.record, null);
  equal(multi.get(firstTab).items[0].text, 'kept first');
  const beforeRead = calls.length;
  multi.get(secondTab);
  equal(calls.length, beforeRead);
  multi.sync(secondTab);
  await tick();
  calls.at(-1).resolve('kept second');
  await tick();
  equal(multi.get(firstTab) === cachedFirst, true);
  multi.sync(firstTab);
  await tick();
  equal(calls.length, beforeRead + 1);
  equal(multi.record === cachedFirst, true);
  multi.refresh(firstTab);
  await tick();
  equal(multi.get(secondTab).items[0].text, 'kept second');
  const pendingMulti = calls.at(-1);
  multi.suspend();
  await tick();
  equal(pendingMulti.cancelled, true);
  equal(multi.get(firstTab), null);
  equal(multi.get(secondTab).state, 'ready');
  multi.clear();
  equal(multi.records.size, 0);
  equal(multi.get(secondTab), null);
  multi.destroy();
  const broken = new GeneratedTabs(null, {
    execute() {
      throw Error('launch failure');
    },
  });
  broken.sync(tab);
  await tick();
  equal(broken.record.state, 'error');
  broken.destroy();
  equal(await runCommand('printf ""', { allowEmptyOutput: true }).promise, '');
  let rejected = false;
  try {
    await runCommand('printf ""').promise;
  } catch {
    rejected = true;
  }
  equal(rejected, true);

  const directory = GLib.dir_make_tmp('paste-board-generated-store.XXXXXX');
  let store;
  try {
    store = new PasteSets(directory);
    const manual = store.create('Existing');
    store.put(manual, { name: 'kept', text: 'keep me' });
    const id = store.create('Hosts', {
      kind: 'generated',
      command: "printf 'one\\ntwo\\n'",
      executionMode: 'bash',
    });
    await store.flush();
    const loaded = new PasteSets(directory);
    equal(loaded.data.sets[0].items[0].text, 'keep me');
    equal(loaded.data.sets[1], {
      id,
      name: 'Hosts',
      items: [],
      kind: 'generated',
      command: "printf 'one\\ntwo\\n'",
      executionMode: 'bash',
    });
    equal(JSON.stringify(loaded.data).includes('tab:generated'), false);
    throws(() => store.put(id, { text: 'no' }));
    throws(() => store.removeItem(id, 'anything'));
    throws(() => store.move(id, 'anything', 1));
    throws(() => store.moveRelative(id, 'a', 'b', true));
    throws(() =>
      store.configure(manual, 'No', {
        kind: 'generated',
        command: 'date',
        executionMode: 'direct',
      }),
    );
    equal(store.data.sets[0].items[0].text, 'keep me');
    for (const options of [
      { kind: 'unknown' },
      { kind: 'generated', command: '' },
      { kind: 'generated', command: 'x'.repeat(8193) },
      { kind: 'generated', command: 'bad\0value' },
      { kind: 'generated', command: 'date', executionMode: 'unknown' },
      { kind: 'generated', command: 'date', runOnSearch: 'true' },
    ])
      throws(() => store.create('Invalid', options));
    equal(store.data.sets.length, 2);
    store.configure(id, 'Renamed', {
      kind: 'generated',
      command: 'date',
      executionMode: 'direct',
    });
    await store.flush();
    equal(new PasteSets(directory).data.sets[1].command, 'date');
    store.configure(id, 'Search enabled', {
      kind: 'generated',
      command: 'date',
      runOnSearch: true,
    });
    await store.flush();
    equal(new PasteSets(directory).data.sets[1].runOnSearch, true);
    store.configure(id, 'Search disabled', {
      kind: 'generated',
      command: 'date',
      runOnSearch: false,
    });
    await store.flush();
    equal(new PasteSets(directory).data.sets[1].runOnSearch, undefined);
    store.configure(id, 'Manual again', { kind: 'manual' });
    await store.flush();
    equal(new PasteSets(directory).data.sets[1], {
      id,
      name: 'Manual again',
      items: [],
    });
    await loaded.close();
  } finally {
    await store?.close();
    GLib.unlink(directory + '/paste-sets.json');
    GLib.rmdir(directory);
  }
  print(`Generated tabs: ${checks} checks passed`);
}
const loop = GLib.MainLoop.new(null, false);
let error;
main()
  .catch((e) => {
    error = e;
  })
  .finally(() => loop.quit());
loop.run();
if (error) throw error;
