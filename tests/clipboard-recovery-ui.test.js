import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
const delay = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );
export default class extends Extension {
  enable() {
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
      this.timer = null;
      this.check()
        .then(() => this.finish('PASS'))
        .catch((error) => {
          console.error(error);
          this.finish('FAIL');
        });
      return GLib.SOURCE_REMOVE;
    });
  }
  disable() {
    if (this.timer) GLib.Source.remove(this.timer);
  }
  finish(result) {
    GLib.file_set_contents(GLib.get_user_cache_dir() + '/result', result);
  }
  async check() {
    const extension = Main.extensionManager.lookup(
      'paste-board@jidaikobo.shibata',
    );
    const owner = extension.stateObj.clipboardIndicator;
    const { readClipboardText } = await import(
      `file://${extension.path}/clipboardRead.js`
    );
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(30);
      }
      throw Error('Timed out waiting for clipboard recovery');
    };
    owner.settings.set_boolean('debug-clipboard', true);
    const expected = 'Recovery fixture\n日本語\n';
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, expected);
    await wait(() => owner.entries.last()?.text === expected);
    owner._clipboardDebug.cancel();
    const logs = [];
    const notifications = [];
    owner._clipboardDebug.log = (line) => logs.push(line);
    owner._showNotification = (...args) => notifications.push(args);
    owner._clipboardDebug.delays = [10];
    owner._clipboardDebug.confirmMs = 10;
    owner.selection.set_owner(
      Meta.SelectionType.SELECTION_CLIPBOARD,
      Meta.SelectionSourceMemory.new(
        'text/plain',
        new GLib.Bytes(new Uint8Array()),
      ),
    );
    await delay(30);
    // Model a source that became empty after the original successful read.
    owner._clipboardDebug.observe(expected);
    await wait(() => logs.some((line) => line.includes('recovery-verified')));
    await wait(() => logs.some((line) => line.includes('incident-saved')));
    const savedLog = logs.find((line) => line.includes('incident-saved'));
    const savedPath = JSON.parse(savedLog.slice(savedLog.indexOf('{'))).path;
    const incident = JSON.parse(
      new TextDecoder().decode(GLib.file_get_contents(savedPath)[1]),
    );
    if (incident.text !== expected)
      throw Error('Incident text differs from original copy');
    owner._clipboardDebug.cancel();
    const text = await readClipboardText(
      owner.selection,
      Meta.SelectionType.SELECTION_CLIPBOARD,
    ).promise;
    if (text !== expected)
      throw Error('Restored clipboard differs from history');
    if (notifications.length !== 1)
      throw Error('Recovery notification missing or repeated');
    if (logs.some((line) => line.includes(expected)))
      throw Error('Clipboard contents leaked to log');
    if (!logs.some((line) => line.includes('recovery-write-succeeded')))
      throw Error('Write outcome missing');
    if (owner.entries.last()?.text !== expected)
      throw Error('Recovery changed history order');
    console.log('Native clipboard recovery and readback: PASS');
  }
}
