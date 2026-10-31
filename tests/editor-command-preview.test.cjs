const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'pasteSetDialog.js'),
  'utf8',
);
function method(name) {
  const start = source.indexOf(`    ${name}(`);
  assert.ok(start >= 0);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n    [a-zA-Z_]\w*\(/) + 1;
  const classEnd = rest.indexOf('\n  },');
  return rest.slice(
    0,
    end > 0 && (classEnd < 0 || end < classEnd) ? end : classEnd,
  );
}
function fixture() {
  const runs = [];
  class Base {
    close() {
      this.closed = true;
    }
  }
  const Class = vm.runInNewContext(
    `(class extends Base {${[
      '_startCommandPreview',
      '_cancelCommandPreview',
      '_setCommandPreviewState',
      'close',
    ]
      .map(method)
      .join('\n')}})`,
    {
      Base,
      _: (x) => x,
      runCommand: (command, options) => {
        let resolve, reject;
        const promise = new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const run = {
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
        runs.push(run);
        return run;
      },
    },
  );
  const dialog = new Class();
  dialog._editorOutput = {
    text: '',
    set_text(text) {
      this.text = text;
    },
  };
  dialog._editorStatus = {};
  dialog._editorRun = {};
  dialog._editorStop = {};
  return { dialog, runs };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('editor preview runs only on request and displays complete output without changing the command', async () => {
  const { dialog, runs } = fixture();
  assert.equal(runs.length, 0);
  dialog._startCommandPreview('printf test', {
    executionMode: 'direct',
    trimTrailingNewlines: false,
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, 'printf test');
  assert.equal(runs[0].options.trimTrailingNewlines, false);
  assert.equal(dialog._editorRun.reactive, false);
  assert.equal(dialog._editorStop.visible, true);
  runs[0].resolve(' first\nsecond\n');
  await tick();
  assert.equal(dialog._editorOutput.text, ' first\nsecond\n');
  assert.equal(dialog._editorRun.reactive, true);
  assert.equal(dialog._editorStop.visible, false);
});
test('editing or stopping invalidates pending output and late results cannot return', async () => {
  const { dialog, runs } = fixture();
  dialog._startCommandPreview('slow', {});
  dialog._cancelCommandPreview();
  assert.equal(runs[0].cancelled, true);
  await tick();
  assert.equal(dialog._editorOutput.text, '');
  assert.equal(dialog._editorPreviewRun, null);
  dialog._startCommandPreview('new', {});
  runs[1].resolve('new result');
  await tick();
  assert.equal(dialog._editorOutput.text, 'new result');
  dialog._cancelCommandPreview();
  assert.equal(dialog._editorOutput.text, '');
});
test('errors are shown as failures and closing prevents new executions', async () => {
  const { dialog, runs } = fixture();
  dialog._startCommandPreview('false', {});
  runs[0].reject(Error('failed'));
  await tick();
  assert.equal(dialog._editorStatus.text, 'Could not execute the command');
  assert.equal(dialog._editorOutput.text, 'failed');
  dialog._startCommandPreview('slow', {});
  dialog.close();
  assert.equal(runs[1].cancelled, true);
  assert.equal(dialog.closed, true);
  await tick();
  dialog._startCommandPreview('must not run', {});
  assert.equal(runs.length, 2);
  assert.equal(dialog._editorOutput.text, '');
});
