// Run the actual state-changing methods with simulated Shell actors and callbacks.
// These tests do not verify native Wayland grabs or application clipboard reads.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');

function method(name) {
  const start = source.indexOf(`  ${name}(`);
  assert.notEqual(start, -1, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n  [a-zA-Z_]\w*\(/) + 1;
  assert.ok(end > 0, name);
  return rest.slice(0, end);
}
function instance(names, globals = {}) {
  const context = vm.createContext({console: {log() {}}, ...globals});
  const Class = vm.runInContext(`(class {${names.map(method).join('\n')}})`, context);
  return [new Class(), context];
}
function callback(begin, end, args, context) {
  const start = source.indexOf(begin) + begin.length;
  assert.ok(start >= begin.length);
  const finish = source.indexOf(end, start);
  assert.ok(finish > start);
  return vm.runInContext(`(function(${args}) {${source.slice(start, finish)}})`, context);
}
const noop = () => {};

function clipboardGlobals(writes) {
  return {
    DS: {TYPE_TEXT: 1}, PAGE_SIZE: 50, PRIVATE_MODE: false, PASTE_ON_SELECTION: true,
    St: {ClipboardType: {CLIPBOARD: 1, PRIMARY: 2}},
    Clipboard: {set_text: (type, text) => writes.push([type, text])},
  };
}

test('initial display and private-mode transitions preserve the clipboard', () => {
  const writes = [];
  const [owner, context] = instance(['_updatePrivateModeState', '_resetSelectedMenuItem',
    '_selectEntry', '_setClipboardText'], clipboardGlobals(writes));
  Object.assign(owner, {
    scrollViewMenuSection: {actor: {}}, scrollViewFavoritesMenuSection: {actor: {}},
    icon: {remove_style_class_name: noop, add_style_class_name: noop},
    _applyPasteSetVisibility: noop, _updateButtonText: noop, _setCandidateSelection: noop,
  });
  owner._updatePrivateModeState();
  owner.currentlySelectedEntry = {type: 1, text: 'old history'};
  context.PRIVATE_MODE = true;
  owner._updatePrivateModeState();
  context.PRIVATE_MODE = false;
  owner._updatePrivateModeState();
  assert.deepEqual(writes, []);
  assert.equal(owner.currentlySelectedEntry, undefined);
  assert.equal(owner._clipboardQueryEpoch, 3);
});

test('rebuilding visible history does not write the selected item to clipboard', () => {
  const writes = [];
  const [owner] = instance(['_maybeRestoreMenuPages', '_selectEntry', '_setClipboardText'], clipboardGlobals(writes));
  const entry = {type: 1, text: 'selected'};
  Object.assign(owner, {
    activeHistoryMenuItems: 0, entries: {last: () => entry}, currentlySelectedEntry: entry,
    _setCandidateSelection: noop, _updateButtonText: noop,
    _addEntry(item, select, update) {
      this.activeHistoryMenuItems++;
      if (select) this._selectEntry(item, update);
    },
  });
  owner._maybeRestoreMenuPages();
  assert.equal(owner.activeHistoryMenuItems, 1);
  assert.deepEqual(writes, []);
});

test('history-loading callback ignores an indicator disabled before completion', () => {
  const context = vm.createContext({});
  const loaded = callback('      (entries, favoriteEntries, nextId, nextDiskId) => {',
    '\n      },\n    );', 'entries, favoriteEntries, nextId, nextDiskId', context);
  const owner = new Proxy({_destroyed: true}, {
    get(target, key) {assert.equal(key, '_destroyed'); return target[key];},
    set() {assert.fail('disabled indicator was changed');},
  });
  loaded.call(owner, {}, {}, 1, 1);
});

test('recycling rows clears old ownership without erasing a newly assigned row', () => {
  const [owner] = instance(['_rewriteMenuItem']);
  Object.assign(owner, {_setEntryLabel: noop, _setCandidateSelection: noop});
  const a = {id: 1}, b = {id: 2}, c = {id: 3};
  const first = {entry: a}, second = {entry: b};
  a.menuItem = first; b.menuItem = second;
  owner._rewriteMenuItem(first, b);
  assert.equal(a.menuItem, undefined);
  owner._rewriteMenuItem(second, c);
  assert.equal(b.menuItem, first);
  assert.equal(c.menuItem, second);
  assert.equal(first.entry, b);
});

function grabFixture() {
  const timers = [];
  let focus;
  const globals = {
    GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, get_monotonic_time: () => 0,
      timeout_add: (_, delay, fn) => {timers.push(fn); return timers.length;}, Source: {remove: noop}},
    global: {stage: {set_key_focus: actor => {focus = actor;}}},
    Clutter: {KeyState: {PRESSED: 1, RELEASED: 0}},
    VirtualKeyboard: () => ({notify_key: noop}),
  };
  const [owner, context] = instance(['_emitPasteGrabState', '_suspendQuickPasteInput',
    '_resumeQuickPasteInput', '_sendPostPasteAction', '_endQuickPasteTracking'], globals);
  const listener = callback("    this.menu.connect('open-state-changed', (self, open) => {",
    '\n    });', 'self, open', context);
  const row = {};
  Object.assign(owner, {
    extension: {uuid: 'test'}, _activePasteTab: 'set', _pasteSets: {},
    searchEntry: {text: 'needle', set_text(value) {this.text = value;}},
    menu: {isOpen: true, emit: (name, open) => listener.call(owner, owner.menu, open)},
    _focusedHistoryCandidate: actor => !actor || actor === row ? row : undefined,
    _visiblePasteCandidates: () => [row],
    _switchPasteTab: id => {owner._activePasteTab = id;},
    _updateCandidateNumbers: noop, _setMenuWidth: noop,
  });
  return {owner, timers, focus: () => focus};
}

test('temporary release and regrab preserve active tab, filter and focused row', () => {
  const {owner, focus} = grabFixture();
  owner._suspendQuickPasteInput();
  owner._resumeQuickPasteInput();
  assert.equal(owner._activePasteTab, 'set');
  assert.equal(owner.searchEntry.text, 'needle');
  assert.equal(focus(), owner._visiblePasteCandidates()[0]);
});

test('post-paste Tab and Enter retain custom tab after busy becomes false', () => {
  for (const action of ['tab', 'enter']) {
    const {owner, timers} = grabFixture();
    owner._sendPostPasteAction(action);
    while (timers.length) timers.shift()();
    assert.equal(owner._quickPasteBusy, false);
    assert.equal(owner._activePasteTab, 'set');
    assert.equal(owner.searchEntry.text, 'needle');
  }
});

test('a real reopen selects history and clears search', () => {
  const {owner, timers} = grabFixture();
  owner.menu.emit('open-state-changed', true);
  while (timers.length) timers.shift()();
  assert.equal(owner._activePasteTab, 'history');
  assert.equal(owner.searchEntry.text, '');
});

test('grab-transition flag is cleared even when a Shell handler throws', () => {
  const {owner} = grabFixture();
  owner.menu.emit = () => {throw new Error('test');};
  assert.throws(() => owner._emitPasteGrabState(true));
  assert.equal(owner._changingPasteGrab, false);
});

test('Enter and click on history respect paste-on-selection, with or without pin', () => {
  for (const paste of [false, true]) for (const pinned of [false, true]) {
    const calls = [];
    const [owner] = instance(['_captureQuickPasteKey', '_activateHistoryEntry', '_onMenuItemSelectedAndMenuClose'], {
      PASTE_ON_SELECTION: paste, modifierBits: () => 0,
      GObject: {signal_stop_emission_by_name: noop},
      St: {Button: class {}}, global: {stage: {get_key_focus: () => row}},
      Clutter: {EventType: {KEY_PRESS: 1, KEY_RELEASE: 2}, KEY_Return: 13, EVENT_STOP: true, EVENT_PROPAGATE: false},
    });
    const row = {entry: {text: 'chosen'}};
    Object.assign(owner, {
      menu: {isOpen: true, close: () => calls.push('close')},
      _keepMenuOpen: pinned, _quickPasteKeysHeld: new Set(),
      _handleCtrlSelectKeyEvent: () => false, _isSearchActor: () => false,
      _visiblePasteCandidates: () => [row],
      _quickPaste: () => calls.push('paste'), _selectEntry: () => calls.push('copy'),
      _moveEntryFirst: noop, _flushDeferredHistoryMoves: noop, _deferHistoryMove: noop,
    });
    owner._captureQuickPasteKey({type: () => 1, get_key_code: () => 36,
      get_state: () => 0, get_key_symbol: () => 13});
    const enterCalls = [...calls];
    calls.length = 0;
    owner._onMenuItemSelectedAndMenuClose(row);
    assert.deepEqual(calls, enterCalls);
    assert.equal(calls.includes('paste'), paste);
    assert.equal(calls.includes('copy'), !paste);
  }
});

test('pending clipboard reads are discarded after disable, privacy transitions or newer reads', () => {
  for (const kind of ['_queryClipboard', '_queryPrimaryClipboard']) {
    for (const change of ['disable', 'privacy', 'newer']) {
      const pending = [], processed = [];
      const [owner] = instance([kind, '_shouldAbortClipboardQuery'], {
        PRIVATE_MODE: false, PROCESS_PRIMARY_SELECTION: true,
        St: {ClipboardType: {CLIPBOARD: 1, PRIMARY: 2}},
        Clipboard: {get_text: (_, fn) => pending.push(fn)},
      });
      Object.assign(owner, {entries: {last: () => null}, _processClipboardContent: text => processed.push(text)});
      owner[kind]();
      if (change === 'disable') owner._destroyed = true;
      if (change === 'privacy') owner._clipboardQueryEpoch = 1;
      if (change === 'newer') {
        if (kind === '_queryClipboard') owner._clipboardGeneration = 1;
        else owner[kind]();
      }
      pending[0](null, 'stale');
      assert.deepEqual(processed, [], `${kind}: ${change}`);
    }
  }
});

test('confirmation Esc cancels and disabling destroys the dialog without deleting', () => {
  let dialog, removed = 0;
  class Actor {add_child() {} set_vertical() {}}
  class Modal {
    constructor(...args) {dialog = this; this.contentLayout = new Actor(); this.signals = {}; this._init(...args);}
    _init() {} connect(name, fn) {this.signals[name] = fn;}
    setButtons(buttons) {this.buttons = buttons;}
    open() {return true;} close() {this.destroy();} destroy() {this.signals.destroy?.();}
  }
  const context = vm.createContext({Clutter: {KEY_Escape: 65307, ActorAlign: {CENTER: 0}},
    St: {BoxLayout: Actor, Label: Actor}, GObject: {registerClass: klass => klass},
    ModalDialog: {ModalDialog: Modal}});
  const confirm = fs.readFileSync(path.join(root, 'confirmDialog.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export function/g, 'function');
  vm.runInContext(confirm + '\nglobalThis.api = {openConfirmDialog, closeConfirmDialog};', context);
  context.api.openConfirmDialog('title', 'message', 'detail', 'delete', 'cancel', () => removed++);
  assert.equal(dialog.buttons[0].key, 65307);
  dialog.buttons[0].action();
  const first = dialog;
  context.api.openConfirmDialog('title', 'message', 'detail', 'delete', 'cancel', () => removed++);
  assert.notEqual(dialog, first);
  context.api.closeConfirmDialog();
  assert.equal(removed, 0);
});

test('paste restores custom-set and numeric selections while retaining explicit history selections', () => {
  for (const custom of [false, true]) for (const operation of ['enter', 'click', 'digit'])
    for (const pinned of [false, true]) for (const externalCopy of [false, true]) {
      let clipboard = 'original';
      let pasted;
      const timers = [];
      const target = {};
      const [owner] = instance(['_quickPaste', '_finishQuickPaste', '_endQuickPasteTracking'], {
        DS: {TYPE_TEXT: 1}, global: {display: {focus_window: target}},
        St: {ClipboardType: {CLIPBOARD: 1}},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
          timeout_add: (_, delay, fn) => {timers.push(fn); return timers.length;}},
        Clipboard: {get_text: (_, fn) => fn(null, clipboard), set_text: (_, value) => {clipboard = value;}},
      });
      Object.assign(owner, {
        menu: {isOpen: true}, _keepMenuOpen: pinned, _pasteAfterAction: 'none',
        _quickPasteKeysAreHeld: () => false,
        _suspendQuickPasteInput: noop, _resumeQuickPasteInput: noop,
        _deferHistoryMove: noop, _flushDeferredHistoryMoves: noop, _moveEntryFirst: noop,
        _selectEntry: noop, _sendPostPasteAction: noop,
        _sendQuickPasteKeys(close) {pasted = clipboard; if (close) this.menu.isOpen = false;},
      });
      const text = '\nbody\n\n';
      owner._quickPaste({type: 1, text, pasteSetItem: custom}, !pinned,
        false, operation !== 'digit', pinned);
      timers.shift()();
      if (externalCopy) {clipboard = 'new copy'; owner._quickPasteState.changed = true;}
      while (timers.length) timers.shift()();
      assert.equal(pasted, text);
      assert.equal(clipboard, externalCopy ? 'new copy'
        : !custom && operation !== 'digit' ? text : 'original',
      JSON.stringify({custom, operation, pinned, externalCopy}));
    }
});

function commandFixture() {
  let resolve, reject;
  let cancelled = 0;
  const running = {promise: new Promise((yes, no) => {resolve = yes; reject = no;}), cancel() {cancelled++;}};
  const target = {};
  const paste = [], errors = [];
  const [owner, context] = instance(['_quickPasteCommand', '_cancelPasteCommand', '_endQuickPasteTracking'], {
    PRIVATE_MODE: false, global: {display: {focus_window: target}}, runCommand: () => running,
  });
  Object.assign(owner, {menu: {isOpen: true},
    _quickPaste: (...args) => paste.push(args), _showNotification: (...args) => errors.push(args)});
  return {owner, context, resolve, reject, paste, errors, cancelled: () => cancelled};
}

test('command output enters temporary plain-text paste and keeps the set item unchanged', async () => {
  const {owner, resolve, paste} = commandFixture();
  const item = {id: 'date', kind: 'command', command: 'date', text: '', pasteSetItem: true};
  owner._quickPasteCommand(item, false, false);
  assert.equal(owner._quickPasteBusy, true);
  assert.equal(paste.length, 0);
  resolve('generated');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner._quickPasteBusy, false);
  assert.equal(paste.length, 1);
  assert.equal(paste[0][0].text, 'generated');
  assert.equal(paste[0][0].kind, 'text');
  assert.equal(paste[0][0].pasteSetItem, true);
  assert.equal(item.kind, 'command');
  assert.equal(item.text, '');
  assert.equal(paste[0].length, 3); // No commitSelection: output must restore the clipboard.
});

test('late command results cannot paste after menu close, disable or context changes', async () => {
  for (const change of ['close', 'disable', 'focus', 'clipboard', 'privacy', 'cancel']) {
    const {owner, context, resolve, paste, cancelled} = commandFixture();
    owner._quickPasteCommand({command: 'date'}, false, false);
    if (change === 'close') owner.menu.isOpen = false;
    if (change === 'disable') owner._destroyed = true;
    if (change === 'focus') context.global.display.focus_window = {};
    if (change === 'clipboard') owner._clipboardGeneration = 1;
    if (change === 'privacy') owner._clipboardQueryEpoch = 1;
    if (change === 'cancel') owner._cancelPasteCommand();
    resolve('late');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(paste, [], change);
    assert.equal(owner._quickPasteBusy, false);
    if (change === 'cancel') assert.equal(cancelled(), 1);
  }
});

test('command errors release busy state without pasting or modifying clipboard', async () => {
  const {owner, reject, paste, errors} = commandFixture();
  owner._quickPasteCommand({command: 'false'}, false, false);
  reject(new Error('failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner._quickPasteBusy, false);
  assert.deepEqual(paste, []);
  assert.equal(errors[0][1], 'failure');
});
