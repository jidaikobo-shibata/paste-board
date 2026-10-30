// Run the actual state-changing methods with simulated Shell actors and callbacks.
// These tests do not verify native Wayland grabs or application clipboard reads.
const { test } = require('node:test');
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
  const context = vm.createContext({
    _: (value) => value,
    PRIVATE_MODE: false,
    console: { log() {} },
    ...globals,
  });
  const Class = vm.runInContext(
    `(class {${names.map(method).join('\n')}})`,
    context,
  );
  return [new Class(), context];
}
function callback(begin, end, args, context) {
  const start = source.indexOf(begin) + begin.length;
  assert.ok(start >= begin.length);
  const finish = source.indexOf(end, start);
  assert.ok(finish > start);
  return vm.runInContext(
    `(${
      begin.includes('async ') ? 'async ' : ''
    }function(${args}) {${source.slice(start, finish)}})`,
    context,
  );
}
const noop = () => {};

function clipboardGlobals(writes) {
  return {
    DS: { TYPE_TEXT: 1 },
    PAGE_SIZE: 50,
    PRIVATE_MODE: false,
    PASTE_ON_SELECTION: true,
    St: { ClipboardType: { CLIPBOARD: 1, PRIMARY: 2 } },
    Clipboard: { set_text: (type, text) => writes.push([type, text]) },
  };
}

test('initial display and private-mode transitions preserve the clipboard', () => {
  const writes = [];
  const [owner, context] = instance(
    [
      '_updatePrivateModeState',
      '_clearCurrentClipboardEntry',
      '_setCurrentClipboardEntry',
      '_setClipboardText',
    ],
    clipboardGlobals(writes),
  );
  Object.assign(owner, {
    scrollViewMenuSection: { actor: {} },
    icon: { remove_style_class_name: noop, add_style_class_name: noop },
    _applyPasteSetVisibility: noop,
    _updateButtonText: noop,
    _queryClipboard: noop,
    _cancelPasteCommand: noop,
  });
  owner._updatePrivateModeState();
  owner._currentClipboardEntry = { type: 1, text: 'old history' };
  context.PRIVATE_MODE = true;
  owner._updatePrivateModeState();
  context.PRIVATE_MODE = false;
  owner._updatePrivateModeState();
  assert.deepEqual(writes, []);
  assert.equal(owner._currentClipboardEntry, undefined);
  assert.equal(owner._clipboardQueryEpoch, 3);
});

test('rebuilding visible history does not write the selected item to clipboard', () => {
  const writes = [];
  const [owner] = instance(
    [
      '_maybeRestoreMenuPages',
      '_setCurrentClipboardEntry',
      '_setClipboardText',
    ],
    clipboardGlobals(writes),
  );
  const entry = { type: 1, text: 'selected' };
  Object.assign(owner, {
    activeHistoryMenuItems: 0,
    entries: { last: () => entry },
    _currentClipboardEntry: entry,
    _updateButtonText: noop,
    _addEntry(item, select, update) {
      this.activeHistoryMenuItems++;
      if (select) this._setCurrentClipboardEntry(item, update);
    },
  });
  owner._maybeRestoreMenuPages();
  assert.equal(owner.activeHistoryMenuItems, 1);
  assert.deepEqual(writes, []);
});

test('history-loading callback ignores an indicator disabled before completion', async () => {
  const context = vm.createContext({});
  const loaded = callback(
    '      async (entries, archivedEntries, nextId, nextDiskId) => {',
    '\n      },\n    );',
    'entries, archivedEntries, nextId, nextDiskId',
    context,
  );
  const owner = new Proxy(
    { _destroyed: true },
    {
      get(target, key) {
        assert.equal(key, '_destroyed');
        return target[key];
      },
      set() {
        assert.fail('disabled indicator was changed');
      },
    },
  );
  await loaded.call(owner, {}, {}, 1, 1);
});

test('recycling rows clears old ownership without erasing a newly assigned row', () => {
  const [owner] = instance(['_rewriteMenuItem']);
  Object.assign(owner, { _setEntryLabel: noop });
  const a = { id: 1 },
    b = { id: 2 },
    c = { id: 3 };
  const first = { entry: a },
    second = { entry: b };
  a.menuItem = first;
  b.menuItem = second;
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
    GLib: {
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      get_monotonic_time: () => 0,
      timeout_add: (_, delay, fn) => {
        timers.push(fn);
        return timers.length;
      },
      Source: { remove: noop },
    },
    global: {
      stage: {
        set_key_focus: (actor) => {
          focus = actor;
        },
      },
    },
    Clutter: { KeyState: { PRESSED: 1, RELEASED: 0 } },
    VirtualKeyboard: () => ({ notify_key: noop }),
  };
  const [owner, context] = instance(
    [
      '_emitPasteGrabState',
      '_suspendQuickPasteInput',
      '_resumeQuickPasteInput',
      '_sendPostPasteAction',
      '_endQuickPasteTracking',
    ],
    globals,
  );
  const listener = callback(
    "    this.menu.connect('open-state-changed', (self, open) => {",
    '\n    });',
    'self, open',
    context,
  );
  const row = {};
  Object.assign(owner, {
    extension: { uuid: 'test' },
    _activePasteTab: 'set',
    _pasteSets: {},
    searchEntry: {
      text: 'needle',
      set_text(value) {
        this.text = value;
      },
    },
    menu: {
      isOpen: true,
      emit: (name, open) => listener.call(owner, owner.menu, open),
    },
    _focusedHistoryCandidate: (actor) =>
      !actor || actor === row ? row : undefined,
    _visiblePasteCandidates: () => [row],
    _switchPasteTab: (id) => {
      owner._activePasteTab = id;
    },
    _updateCandidateNumbers: noop,
    _setMenuWidth: noop,
  });
  return { owner, timers, focus: () => focus };
}

test('temporary release and regrab preserve active tab, filter and focused row', () => {
  const { owner, focus } = grabFixture();
  owner._suspendQuickPasteInput();
  owner._resumeQuickPasteInput();
  assert.equal(owner._activePasteTab, 'set');
  assert.equal(owner.searchEntry.text, 'needle');
  assert.equal(focus(), owner._visiblePasteCandidates()[0]);
});

test('post-paste Tab and Enter retain custom tab after busy becomes false', () => {
  for (const action of ['tab', 'enter']) {
    const { owner, timers } = grabFixture();
    owner._sendPostPasteAction(action);
    while (timers.length) timers.shift()();
    assert.equal(owner._quickPasteBusy, false);
    assert.equal(owner._activePasteTab, 'set');
    assert.equal(owner.searchEntry.text, 'needle');
  }
});

test('a real reopen selects history and clears search', () => {
  const { owner, timers } = grabFixture();
  owner.menu.emit('open-state-changed', true);
  while (timers.length) timers.shift()();
  assert.equal(owner._activePasteTab, 'history');
  assert.equal(owner.searchEntry.text, '');
});

test('grab-transition flag is cleared even when a Shell handler throws', () => {
  const { owner } = grabFixture();
  owner.menu.emit = () => {
    throw new Error('test');
  };
  assert.throws(() => owner._emitPasteGrabState(true));
  assert.equal(owner._changingPasteGrab, false);
});

test('Enter and click on history respect paste-on-selection, with or without pin', () => {
  for (const paste of [false, true])
    for (const pinned of [false, true]) {
      const calls = [];
      const [owner] = instance(
        ['_captureQuickPasteKey', '_activatePasteEntry', '_activateHistoryRow'],
        {
          PASTE_ON_SELECTION: paste,
          modifierBits: () => 0,
          GObject: { signal_stop_emission_by_name: noop },
          St: { Button: class {} },
          global: { stage: { get_key_focus: () => row } },
          Clutter: {
            EventType: { KEY_PRESS: 1, KEY_RELEASE: 2 },
            KEY_Return: 13,
            EVENT_STOP: true,
            EVENT_PROPAGATE: false,
          },
        },
      );
      const row = { entry: { text: 'chosen' } };
      Object.assign(owner, {
        menu: { isOpen: true, close: () => calls.push('close') },
        _keepMenuOpen: pinned,
        _quickPasteKeysHeld: new Set(),
        _handleCtrlSelectKeyEvent: () => false,
        _isSearchActor: () => false,
        _visiblePasteCandidates: () => [row],
        _quickPaste: () => calls.push('paste'),
        _copyPasteEntry: () => calls.push('copy'),
        _moveEntryFirst: noop,
        _flushDeferredHistoryMoves: noop,
        _deferHistoryMove: noop,
      });
      owner._captureQuickPasteKey({
        type: () => 1,
        get_key_code: () => 36,
        get_state: () => 0,
        get_key_symbol: () => 13,
      });
      const enterCalls = [...calls];
      calls.length = 0;
      owner._activateHistoryRow(row);
      assert.deepEqual(calls, enterCalls);
      assert.equal(calls.includes('paste'), paste);
      assert.equal(calls.includes('copy'), !paste);
    }
});

test('pending clipboard reads are discarded after disable, privacy transitions or newer reads', () => {
  for (const kind of ['_queryClipboard', '_queryPrimaryClipboard']) {
    for (const change of ['disable', 'privacy', 'newer']) {
      const pending = [],
        processed = [];
      const [owner] = instance([kind], {
        PRIVATE_MODE: false,
        PROCESS_PRIMARY_SELECTION: true,
        St: { ClipboardType: { CLIPBOARD: 1, PRIMARY: 2 } },
        Clipboard: { get_text: (_, fn) => pending.push(fn) },
      });
      Object.assign(owner, {
        entries: { last: () => null },
        _processClipboardContent: (text) => processed.push(text),
      });
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
  let dialog,
    removed = 0;
  class Actor {
    add_child() {}
    set_vertical() {}
  }
  class Modal {
    constructor(...args) {
      dialog = this;
      this.contentLayout = new Actor();
      this.signals = {};
      this._init(...args);
    }
    _init() {}
    connect(name, fn) {
      this.signals[name] = fn;
    }
    setButtons(buttons) {
      this.buttons = buttons;
    }
    open() {
      return true;
    }
    close() {
      this.destroy();
    }
    destroy() {
      this.signals.destroy?.();
    }
  }
  const context = vm.createContext({
    Clutter: { KEY_Escape: 65307, ActorAlign: { CENTER: 0 } },
    St: { BoxLayout: Actor, Label: Actor },
    GObject: { registerClass: (klass) => klass },
    ModalDialog: { ModalDialog: Modal },
  });
  const confirm = fs
    .readFileSync(path.join(root, 'confirmDialog.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/export function/g, 'function');
  vm.runInContext(
    confirm + '\nglobalThis.api = {openConfirmDialog, closeConfirmDialog};',
    context,
  );
  context.api.openConfirmDialog(
    'title',
    'message',
    'detail',
    'delete',
    'cancel',
    () => removed++,
  );
  assert.equal(dialog.buttons[0].key, 65307);
  dialog.buttons[0].action();
  const first = dialog;
  context.api.openConfirmDialog(
    'title',
    'message',
    'detail',
    'delete',
    'cancel',
    () => removed++,
  );
  assert.notEqual(dialog, first);
  context.api.closeConfirmDialog();
  assert.equal(removed, 0);
});

test('paste restores custom-set and numeric selections while retaining explicit history selections', () => {
  for (const custom of [false, true])
    for (const operation of ['enter', 'click', 'digit'])
      for (const pinned of [false, true])
        for (const externalCopy of [false, true]) {
          let clipboard = 'original';
          let pasted;
          const timers = [];
          const target = {};
          const [owner] = instance(
            ['_quickPaste', '_finishQuickPaste', '_endQuickPasteTracking'],
            {
              DS: { TYPE_TEXT: 1 },
              global: { display: { focus_window: target } },
              St: { ClipboardType: { CLIPBOARD: 1 } },
              GLib: {
                PRIORITY_DEFAULT: 0,
                SOURCE_REMOVE: false,
                SOURCE_CONTINUE: true,
                timeout_add: (_, delay, fn) => {
                  timers.push(fn);
                  return timers.length;
                },
              },
              Clipboard: {
                get_text: (_, fn) => fn(null, clipboard),
                set_text: (_, value) => {
                  clipboard = value;
                },
              },
            },
          );
          Object.assign(owner, {
            menu: { isOpen: true },
            _keepMenuOpen: pinned,
            _pasteAfterAction: 'none',
            _quickPasteKeysAreHeld: () => false,
            _suspendQuickPasteInput: noop,
            _resumeQuickPasteInput: noop,
            _deferHistoryMove: noop,
            _flushDeferredHistoryMoves: noop,
            _moveEntryFirst: noop,
            _setCurrentClipboardEntry: noop,
            _sendPostPasteAction: noop,
            _sendQuickPasteKeys(close) {
              pasted = clipboard;
              if (close) this.menu.isOpen = false;
            },
          });
          const text = '\nbody\n\n';
          owner._quickPaste(
            { type: 1, text, pasteSetItem: custom },
            !pinned,
            false,
            operation !== 'digit',
          );
          timers.shift()();
          if (externalCopy) {
            clipboard = 'new copy';
            owner._quickPasteState.changed = true;
          }
          while (timers.length) timers.shift()();
          assert.equal(pasted, text);
          assert.equal(
            clipboard,
            externalCopy
              ? 'new copy'
              : !custom && !pinned && operation !== 'digit'
              ? text
              : 'original',
            JSON.stringify({ custom, operation, pinned, externalCopy }),
          );
        }
});

function commandFixture() {
  let resolve, reject;
  let cancelled = 0;
  const running = {
    promise: new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    cancel() {
      cancelled++;
    },
  };
  const target = {};
  const paste = [],
    errors = [];
  const launches = [];
  const [owner, context] = instance(
    ['_quickPasteCommand', '_cancelPasteCommand', '_endQuickPasteTracking'],
    {
      PRIVATE_MODE: false,
      global: { display: { focus_window: target } },
      runCommand: (...args) => {
        launches.push(args);
        return running;
      },
    },
  );
  Object.assign(owner, {
    menu: { isOpen: true },
    _quickPaste: (...args) => paste.push(args),
    _showNotification: (...args) => errors.push(args),
  });
  return {
    owner,
    context,
    resolve,
    reject,
    paste,
    errors,
    launches,
    cancelled: () => cancelled,
  };
}

test('command items forward their normalized execution mode unchanged', async () => {
  for (const mode of ['direct', 'bash']) {
    const { owner, resolve, launches } = commandFixture();
    owner._quickPasteCommand(
      { command: 'date', executionMode: mode },
      false,
      false,
    );
    assert.equal(launches[0][1].executionMode, mode);
    resolve('date output');
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('command output enters temporary plain-text paste and keeps the set item unchanged', async () => {
  const { owner, resolve, paste } = commandFixture();
  const item = {
    id: 'date',
    kind: 'command',
    command: 'date',
    text: '',
    pasteSetItem: true,
  };
  owner._quickPasteCommand(item, false, false);
  assert.equal(owner._quickPasteBusy, true);
  assert.equal(paste.length, 0);
  resolve('generated');
  await new Promise((resolve) => setImmediate(resolve));
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
  for (const change of [
    'close',
    'disable',
    'focus',
    'clipboard',
    'privacy',
    'cancel',
  ]) {
    const { owner, context, resolve, paste, cancelled } = commandFixture();
    owner._quickPasteCommand({ command: 'date' }, false, false);
    if (change === 'close') owner.menu.isOpen = false;
    if (change === 'disable') owner._destroyed = true;
    if (change === 'focus') context.global.display.focus_window = {};
    if (change === 'clipboard') owner._clipboardGeneration = 1;
    if (change === 'privacy') owner._clipboardQueryEpoch = 1;
    if (change === 'cancel') owner._cancelPasteCommand();
    resolve('late');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(paste, [], change);
    assert.equal(owner._quickPasteBusy, false);
    if (change === 'cancel') assert.equal(cancelled(), 1);
  }
});

test('command errors release busy state without pasting or modifying clipboard', async () => {
  const { owner, reject, paste, errors } = commandFixture();
  owner._quickPasteCommand({ command: 'false' }, false, false);
  reject(new Error('failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner._quickPasteBusy, false);
  assert.deepEqual(paste, []);
  assert.equal(errors[0][1], 'failure');
});

function insertionFixture() {
  class Line {
    hide() {
      this.visible = false;
    }
    show() {
      this.visible = true;
    }
    set_position(x, y) {
      this.position = [x, y];
    }
    set_size(width, height) {
      this.size = [width, height];
    }
  }
  const [owner] = instance(
    [
      '_showPasteInsertionLine',
      '_updatePasteInsertionLine',
      '_clearPasteDropHighlight',
    ],
    {
      St: { Widget: Line },
      Main: { uiGroup: { add_child: noop } },
    },
  );
  const rows = [100, 138, 176].map((y) => ({
    entry: {},
    get_transformed_position: () => [20, y],
    get_transformed_size: () => [200, 30],
  }));
  Object.assign(owner, {
    menu: { isOpen: true },
    _pasteSetSection: { _getMenuItems: () => rows },
    _pasteSetScroll: {
      mapped: true,
      get_transformed_position: () => [15, 90],
      get_transformed_size: () => [210, 150],
    },
  });
  return { owner, rows };
}

test('insertion line marks the same gap from either adjacent row without changing rows', () => {
  const { owner, rows } = insertionFixture();
  owner._showPasteInsertionLine(rows[0], true);
  const line = owner._pasteInsertionLine;
  assert.deepEqual(line.position, [28, 133]); // Boundary is midway between 130 and 138.
  assert.deepEqual(line.size, [184, 2]);
  owner._showPasteInsertionLine(rows[1], false);
  assert.equal(owner._pasteInsertionLine, line);
  assert.deepEqual(line.position, [28, 133]);
  owner._showPasteInsertionLine(rows[2], true);
  assert.deepEqual(line.position, [28, 205]);
  owner._clearPasteDropHighlight();
  assert.equal(line.visible, false);
  assert.equal(owner._pasteDropPlacement, undefined);
});

test('insertion line follows scrolling, hides outside viewport and forgets removed rows', () => {
  const { owner, rows } = insertionFixture();
  owner._showPasteInsertionLine(rows[1], false);
  const line = owner._pasteInsertionLine;
  rows[0].get_transformed_position = () => [20, 60];
  rows[1].get_transformed_position = () => [20, 98];
  owner._updatePasteInsertionLine();
  assert.deepEqual(line.position, [28, 93]);
  rows[0].get_transformed_position = () => [20, 20];
  rows[1].get_transformed_position = () => [20, 58];
  owner._updatePasteInsertionLine();
  assert.equal(line.visible, false);
  rows.splice(1, 1);
  owner._updatePasteInsertionLine();
  assert.equal(owner._pasteDropPlacement, undefined);
});

function geometryActor(x, y, width, height, scale = 1) {
  return {
    width,
    height,
    get_transformed_position: () => [x, y],
    get_transformed_size: () => [width * scale, height * scale],
    transform_stage_point: (px, py) => [
      true,
      (px - x) / scale,
      (py - y) / scale,
    ],
  };
}

test('new-tab drops accept only visible tab-strip space, including scaled and scrolled strips', () => {
  const [owner] = instance(['_isPasteTabSpace']);
  const scroll = geometryActor(100, 50, 300, 40);
  const box = geometryActor(100, 50, 300, 40);
  box.get_children = () => [
    geometryActor(100, 50, 60, 40),
    geometryActor(168, 50, 70, 40),
  ];
  Object.assign(owner, { _tabsScroll: scroll, _tabsBox: box });
  assert.equal(owner._isPasteTabSpace(box, 200, 20), true);
  assert.equal(owner._isPasteTabSpace(scroll, 10, 20), false);
  assert.equal(owner._isPasteTabSpace(scroll, 80, 20), false);
  assert.equal(owner._isPasteTabSpace(scroll, 300, 20), false);
  assert.equal(owner._isPasteTabSpace(scroll, 200, -1), false);
  const scaled = geometryActor(100, 50, 300, 40, 2);
  scaled.get_children = () => [geometryActor(100, 50, 60, 40, 2)];
  owner._tabsScroll = owner._tabsBox = scaled;
  assert.equal(owner._isPasteTabSpace(scaled, 10, 20), false);
  assert.equal(owner._isPasteTabSpace(scaled, 200, 20), true);
  owner._tabsScroll = scroll;
  owner._tabsBox = geometryActor(-100, 50, 600, 40);
  owner._tabsBox.get_children = () => [geometryActor(100, 50, 150, 40)];
  assert.equal(owner._isPasteTabSpace(owner._tabsBox, 200, 20), false);
  assert.equal(owner._isPasteTabSpace(owner._tabsBox, 400, 20), true);
  assert.equal(owner._isPasteTabSpace(owner._tabsBox, 550, 20), false);
});

test('dropping into tab space creates one copy and defers activation until drag ends', () => {
  const timers = [],
    callbacks = {},
    switches = [],
    copies = [];
  const [owner] = instance(
    ['_makePasteTabSpaceDropTarget', '_makePasteItemDraggable'],
    {
      PRIVATE_MODE: false,
      DND: {
        DragMotionResult: { NO_DROP: 0, COPY_DROP: 1 },
        makeDraggable: () => ({
          connect: (name, fn) => {
            callbacks[name] = fn;
          },
        }),
      },
      GLib: {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        Source: { remove: noop },
        timeout_add: (_, ms, fn) => {
          timers.push(fn);
          return timers.length;
        },
      },
    },
  );
  const actor = {};
  Object.assign(owner, {
    _pasteSets: {
      createFromItem: (item) => {
        copies.push(item);
        return 'created';
      },
    },
    _isPasteTabSpace: (_, x) => x > 100,
    _clearPasteDropHighlight: noop,
    _stopPasteDragFeedback: noop,
    _switchPasteTab: (id) => switches.push(id),
    _tabsScroll: { add_style_pseudo_class: noop },
  });
  const item = { text: 'original' };
  const source = { pasteDragOwner: owner, getPasteDragContent: () => item };
  owner._makePasteTabSpaceDropTarget(actor);
  assert.equal(actor._delegate.acceptDrop(source, null, 50, 10), false);
  assert.equal(
    actor._delegate.acceptDrop({ pasteDragOwner: {} }, null, 150, 10),
    false,
  );
  assert.equal(actor._delegate.acceptDrop(source, null, 150, 10), true);
  assert.deepEqual(copies, [item]);
  assert.deepEqual(switches, []);
  owner._makePasteItemDraggable({ entry: { text: 'original' }, label: {} });
  callbacks['drag-end']();
  while (timers.length) timers.shift()();
  assert.deepEqual(switches, ['created']);
  assert.equal(owner._pasteDropNewTab, undefined);
});

test('pin click immediately enables keep-open with no post-paste key, second click disables it', () => {
  class Button {
    constructor() {
      this.handlers = {};
    }
    connect(name, fn) {
      this.handlers[name] = fn;
    }
  }
  const [owner] = instance(['_createModeButton'], {
    St: { Button, Icon: class {} },
    Atk: { Role: { TOGGLE_BUTTON: 1 } },
    SettingsFields: { KEEP_MENU_OPEN: 'keep-menu-open' },
  });
  const writes = [];
  Object.assign(owner, {
    _keepMenuOpen: false,
    _pasteAfterAction: 'tab',
    settings: {
      set_boolean(key, value) {
        writes.push([key, value]);
        owner._keepMenuOpen = value;
      },
    },
  });
  const button = owner._createModeButton('pin', 'keep menu', 'keep-menu-open');
  button.handlers.clicked();
  assert.equal(owner._keepMenuOpen, true);
  assert.equal(owner._pasteAfterAction, 'none');
  assert.equal(owner._choosingPasteAction, false);
  button.handlers.clicked();
  assert.equal(owner._keepMenuOpen, false);
  owner._quickPasteBusy = true;
  button.handlers.clicked();
  assert.deepEqual(writes, [
    ['keep-menu-open', true],
    ['keep-menu-open', false],
  ]);
});

test('copy-only mode records every tab and command output as the current clipboard', () => {
  for (const pinned of [false, true])
    for (const custom of [false, true])
      for (const command of [false, true]) {
        if (!custom && command) continue;
        const copied = [],
          moved = [],
          commands = [],
          closed = [];
        const [owner] = instance(['_activatePasteEntry', '_copyPasteEntry'], {
          PASTE_ON_SELECTION: false,
          STRIP_TEXT: false,
          St: { ClipboardType: { CLIPBOARD: 1 } },
          Clipboard: { set_text: (_, text) => copied.push(text) },
        });
        Object.assign(owner, {
          _keepMenuOpen: pinned,
          menu: { close: () => closed.push(true) },
          _processClipboardContent: (text, select, external) => {
            assert.equal(select, true);
            assert.equal(external, true);
            moved.push(text);
          },
          _quickPaste: () => assert.fail('copy-only injected paste'),
          _quickPasteCommand: (...args) => commands.push(args),
        });
        const entry = {
          text: 'chosen',
          kind: command ? 'command' : 'text',
          pasteSetItem: custom,
        };
        owner._activatePasteEntry(entry);
        if (command) {
          assert.equal(commands[0][3], true);
          assert.deepEqual(copied, []);
        } else {
          assert.deepEqual(copied, ['chosen']);
          assert.deepEqual(moved, ['chosen']);
          assert.equal(closed.length, pinned ? 0 : 1);
        }
      }
});

test('fixed history paste preserves the clipboard and order on paste or close', () => {
  const copied = [],
    timers = [],
    moves = [];
  const target = {};
  const [owner, context] = instance(['_quickPaste'], {
    DS: { TYPE_TEXT: 1 },
    global: { display: { focus_window: target } },
    St: { ClipboardType: { CLIPBOARD: 1 } },
    Clipboard: {
      get_text: (_, fn) => fn(null, 'original'),
      set_text: (_, value) => copied.push(value),
    },
    GLib: {
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      timeout_add: (_, ms, fn) => {
        timers.push(fn);
        return timers.length;
      },
      Source: { remove: noop },
    },
  });
  Object.assign(owner, {
    menu: { isOpen: true },
    _keepMenuOpen: true,
    _quickPasteKeysAreHeld: () => false,
    _suspendQuickPasteInput: noop,
    _sendQuickPasteKeys: noop,
    _moveEntryFirst: (entry) => moves.push(entry),
    _setCurrentClipboardEntry: noop,
    _stopPasteDragFeedback: noop,
    _cancelPasteCommand: noop,
    _updatePasteActionChooser: noop,
    _hideModeHint: noop,
    _quickPasteKeysHeld: new Set(),
  });
  owner._quickPaste({ type: 1, text: 'chosen' }, false, false, true);
  timers.shift()();
  assert.deepEqual(copied, ['chosen']);
  assert.deepEqual(moves, []);
  const listener = callback(
    "    this.menu.connect('open-state-changed', (self, open) => {",
    '\n    });',
    'self, open',
    context,
  );
  owner.menu.isOpen = false;
  listener.call(owner, owner.menu, false);
  assert.deepEqual(moves, []);
});

test('command copy-only results use clipboard copy without a paste key', async () => {
  const { owner, resolve, paste } = commandFixture();
  const copied = [];
  owner._copyPasteEntry = (entry) => copied.push(entry.text);
  owner._quickPasteCommand(
    { command: 'date', pasteSetItem: true },
    false,
    false,
    true,
  );
  resolve('generated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ['generated']);
  assert.deepEqual(paste, []);
});

test('clearing all history always requires confirmation', () => {
  const [owner] = instance(['_removeAll']);
  let confirmations = 0;
  owner._confirmRemoveAll = () => confirmations++;
  owner._clearHistory = () => assert.fail('cleared without confirmation');
  owner._removeAll();
  assert.equal(confirmations, 1);
});

test('history load finishing after disable cannot initialize UI or listeners', async () => {
  const context = vm.createContext({});
  const loaded = callback(
    '      async (entries, archivedEntries, nextId, nextDiskId) => {',
    '\n      },\n    );',
    'entries, archivedEntries, nextId, nextDiskId',
    context,
  );
  let ready;
  const owner = {
    _destroyed: false,
    _prepareHistorySession: () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  };
  const pending = loaded.call(owner, {}, {}, 1, 1);
  owner._destroyed = true;
  ready(false);
  await pending;
  assert.equal(owner.entries, undefined);
  assert.equal(owner._settingsChangedId, undefined);
});

test('row activation retains the panel until asynchronous paste handles closing', () => {
  for (const pinned of [false, true])
    for (const custom of [false, true]) {
      let stopped = false;
      const row = { entry: { text: 'chosen', pasteSetItem: custom } };
      const [owner] = instance(['_activateHistoryRow'], {
        GObject: {
          signal_stop_emission_by_name: (item, signal) => {
            assert.equal(item, row);
            assert.equal(signal, 'activate');
            stopped = true;
          },
        },
      });
      Object.assign(owner, {
        _keepMenuOpen: pinned,
        _activatePasteEntry: (entry) => {
          assert.equal(stopped, true);
          assert.equal(entry, row.entry);
        },
      });
      if (custom) {
        const activate = callback(
          "        row.connect('activate', () => {",
          '\n        });',
          '',
          vm.createContext({
            row,
            GObject: {
              signal_stop_emission_by_name: () => {
                stopped = true;
              },
            },
          }),
        );
        activate.call(owner);
      } else owner._activateHistoryRow(row);
      assert.equal(stopped, true);
    }
});

test('pasting saved text works with an initially empty clipboard and restores empty text', () => {
  for (const original of [null, undefined, '', 'previous']) {
    const target = {},
      writes = [],
      timers = [];
    const [owner] = instance(['_quickPaste', '_finishQuickPaste'], {
      DS: { TYPE_TEXT: 'text' },
      global: { display: { focus_window: target } },
      St: { ClipboardType: { CLIPBOARD: 1 } },
      Clipboard: {
        get_text: (_, fn) => fn(null, original),
        set_text: (_, text) => writes.push(text),
      },
      GLib: {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        timeout_add: (_, ms, fn) => {
          timers.push(fn);
          return timers.length;
        },
      },
    });
    let pasted = 0;
    Object.assign(owner, {
      menu: { isOpen: true },
      _quickPasteKeysAreHeld: () => false,
      _suspendQuickPasteInput: noop,
      _resumeQuickPasteInput: noop,
      _endQuickPasteTracking: noop,
      _sendQuickPasteKeys: () => {
        pasted++;
      },
    });
    owner._quickPaste({ type: 'text', text: 'saved text' }, true);
    assert.equal(timers.length, 1);
    timers.shift()();
    assert.equal(pasted, 1);
    timers.shift()();
    assert.deepEqual(writes, ['saved text', original ?? '']);
  }
});

function historyFixture(options = {}) {
  const dsContext = vm.createContext({});
  const dsSource = fs
    .readFileSync(path.join(root, 'dataStructures.js'), 'utf8')
    .replace(/export /g, '');
  const DS = vm.runInContext(
    dsSource + '\n({LLNode, LinkedList, TYPE_TEXT})',
    dsContext,
  );
  let clipboard = '',
    nextDiskId = 1;
  const disk = [],
    rows = [];
  const [owner, context] = instance(
    [
      '_processClipboardContent',
      '_moveEntryFirst',
      '_setCurrentClipboardEntry',
      '_copyPasteEntry',
      '_setClipboardText',
      '_clearCurrentClipboardEntry',
      '_queryPrimaryClipboard',
      '_pruneOldestEntries',
      '_removeEntry',
      '_refreshHistoryAfterRemoval',
      '_deleteEntryAndRestoreLatest',
      '_clearHistory',
    ],
    {
      DS,
      STRIP_TEXT: false,
      COPY_FEEDBACK: 0,
      MAX_REGISTRY_LENGTH: options.limit || 50,
      MAX_BYTES: Infinity,
      PASTE_ON_SELECTION: false,
      PROCESS_PRIMARY_SELECTION: true,
      PRIVATE_MODE: false,
      St: { ClipboardType: { CLIPBOARD: 1, PRIMARY: 2 } },
      Clipboard: {
        set_text: (type, text) => {
          if (type === 1) clipboard = text;
        },
        get_text: (_, fn) => fn(null, options.primary?.()),
      },
      Store: {
        storeTextEntry: (text) => disk.push({ id: nextDiskId++, text }),
        moveEntryToEnd: (id) => {
          const index = disk.findIndex((item) => item.id === id);
          assert.ok(index >= 0);
          disk.push(...disk.splice(index, 1));
        },
        deleteTextEntry: (id) => {
          const index = disk.findIndex((item) => item.id === id);
          assert.ok(index >= 0);
          disk.splice(index, 1);
        },
        maybePerformLogCompaction: noop,
        resetDatabase: () => {
          disk.length = 0;
        },
      },
    },
  );
  Object.assign(owner, {
    searchEntry: { get_text: () => '' },
    entries: new DS.LinkedList(),
    _archivedHistoryEntries: new DS.LinkedList(),
    _pasteSets: {},
    nextId: 1,
    nextDiskId: 1,
    menu: { close: noop },
    _updateButtonText: noop,
    _updateCandidateNumbers: noop,
    _maybeRestoreMenuPages: noop,
    _currentStateBuilder: noop,
    historySection: {
      moveMenuItem: (row, index) => {
        rows.splice(rows.indexOf(row), 1);
        rows.splice(index, 0, row);
      },
      removeAll: () => {
        rows.length = 0;
      },
    },
    _addEntry(entry, selected, update, index = rows.length) {
      const row = {
        entry,
        destroy: () => {
          rows.splice(rows.indexOf(row), 1);
          delete entry.menuItem;
        },
      };
      entry.menuItem = row;
      rows.splice(index, 0, row);
      if (selected) this._setCurrentClipboardEntry(entry, update);
    },
  });
  return {
    owner,
    context,
    rows,
    disk,
    clipboard: () => clipboard,
    copy(text) {
      clipboard = text;
      owner._processClipboardContent(text, true, true);
    },
    order: () =>
      Array.from(owner.entries.toArray(), (item) => item.text).reverse(),
    checkOrder() {
      assert.deepEqual(
        rows.map((row) => row.entry.text),
        this.order(),
      );
      assert.deepEqual(disk.map((item) => item.text).reverse(), this.order());
    },
  };
}

test('ordinary copies and copy-only actions always make history first equal clipboard', () => {
  const fixture = historyFixture();
  const { owner } = fixture;
  for (const text of ['first', 'second', 'third', 'first']) {
    fixture.copy(text);
    assert.equal(fixture.order()[0], fixture.clipboard());
    fixture.checkOrder();
  }
  for (const pinned of [true, false])
    for (const custom of [true, false]) {
      owner._keepMenuOpen = pinned;
      owner._copyPasteEntry({
        text: custom ? 'set output' : 'second',
        pasteSetItem: custom,
      });
      assert.equal(fixture.order()[0], fixture.clipboard());
      fixture.checkOrder();
    }
});

test('PRIMARY text stays below current clipboard, coalesces without deleting it, and persists order', () => {
  let primary;
  const fixture = historyFixture({ primary: () => primary });
  const { owner } = fixture;
  fixture.copy('current');
  for (primary of ['cur', 'current expanded', 'other', 'other expanded']) {
    owner._queryPrimaryClipboard();
    assert.equal(fixture.clipboard(), 'current');
    assert.equal(fixture.order()[0], 'current');
    fixture.checkOrder();
  }
  assert.equal(fixture.order().includes('other'), false);
  primary = 'current';
  owner._queryPrimaryClipboard();
  primary = 'current plus';
  owner._queryPrimaryClipboard();
  assert.equal(fixture.order()[0], 'current');
  fixture.checkOrder();
  fixture.copy('other expanded');
  assert.equal(fixture.order()[0], 'other expanded');
  fixture.checkOrder();
});

test('PRIMARY capture with a one-entry limit cannot evict the current clipboard', () => {
  const fixture = historyFixture({ limit: 1, primary: () => 'selected' });
  fixture.copy('current');
  fixture.owner._queryPrimaryClipboard();
  assert.deepEqual(fixture.order(), ['current']);
  assert.equal(fixture.clipboard(), 'current');
  fixture.checkOrder();
});

test('deleting current history selects the next first item; clearing also clears clipboard', () => {
  const fixture = historyFixture();
  fixture.copy('older');
  fixture.copy('current');
  fixture.owner._deleteEntryAndRestoreLatest(fixture.owner.entries.last());
  assert.equal(fixture.clipboard(), 'older');
  fixture.checkOrder();
  fixture.owner._clearHistory();
  assert.deepEqual(fixture.order(), []);
  assert.equal(fixture.clipboard(), '');
});

test('trimmed history and clipboard remain identical while PRIMARY never changes clipboard', () => {
  const fixture = historyFixture({ primary: () => ' selected \n' });
  fixture.context.STRIP_TEXT = true;
  fixture.copy('\n current \n');
  assert.equal(fixture.clipboard(), 'current');
  assert.equal(fixture.order()[0], 'current');
  fixture.owner._queryPrimaryClipboard();
  assert.equal(fixture.clipboard(), 'current');
  fixture.checkOrder();
});

test('startup restores saved first text only into an empty text-only clipboard', () => {
  for (const text of [null, '', 'existing'])
    for (const mimetypes of [
      [],
      ['text/plain;charset=utf-8'],
      ['image/png'],
      ['text/plain', 'image/png'],
    ]) {
      for (const restoreEmpty of [true, false]) {
        const restored = [],
          processed = [],
          entry = { text: 'saved' };
        const [owner] = instance(['_queryClipboard'], {
          PRIVATE_MODE: false,
          St: { ClipboardType: { CLIPBOARD: 1 } },
          Meta: { SelectionType: { SELECTION_CLIPBOARD: 1 } },
          Clipboard: { get_text: (_, fn) => fn(null, text) },
        });
        Object.assign(owner, {
          entries: { last: () => entry },
          selection: { get_mimetypes: () => mimetypes },
          _setCurrentClipboardEntry: (item, update) => {
            assert.equal(item, entry);
            assert.equal(update, true);
            restored.push(item.text);
          },
          _processClipboardContent: (value) => processed.push(value),
        });
        owner._queryClipboard(true, restoreEmpty);
        const shouldRestore =
          !text && restoreEmpty && !mimetypes.includes('image/png');
        assert.equal(restored.length, shouldRestore ? 1 : 0);
        assert.equal(processed.length, shouldRestore ? 0 : 1);
      }
    }
});

function feedbackFixture({
  iconVisible = true,
  animated = true,
  mode = 5,
} = {}) {
  const actors = [],
    timers = new Map(),
    notifications = [];
  let nextTimer = 0;
  class Actor {
    constructor(props) {
      Object.assign(this, props);
      actors.push(this);
    }
    ease(props) {
      this.animation = props;
    }
    destroy() {
      assert.notEqual(this.destroyed, true);
      this.destroyed = true;
    }
    get_preferred_width() {
      return [80, 80];
    }
    get_preferred_height() {
      return [24, 24];
    }
    set_position(x, y) {
      Object.assign(this, { x, y });
    }
    set_size(width, height) {
      Object.assign(this, { width, height });
    }
  }
  const panel = {
    mapped: true,
    get_transformed_position: () => [0, 0],
    get_transformed_size: () => [1280, 32],
  };
  const icon = {
    visible: iconVisible,
    mapped: iconVisible,
    get_transformed_position: () => [1000, 4],
    get_transformed_size: () => [20, 24],
    add_style_class_name: noop,
    remove_style_class_name: noop,
  };
  const [owner, context] = instance(['_highlightCopy', '_clearCopyHighlight'], {
    PRIVATE_MODE: false,
    COPY_FEEDBACK: mode,
    Main: {
      panel,
      uiGroup: { add_child: noop },
      layoutManager: {
        findMonitorForActor: () => ({ x: 0, y: 0, width: 1280, height: 720 }),
      },
    },
    St: {
      Widget: Actor,
      Label: Actor,
      Settings: { get: () => ({ enable_animations: animated }) },
    },
    Clutter: { AnimationMode: { EASE_OUT_QUAD: 1 } },
    GLib: {
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      timeout_add: (_, delay, fn) => {
        const id = ++nextTimer;
        timers.set(id, { delay, fn });
        return id;
      },
      Source: { remove: (id) => timers.delete(id) },
    },
  });
  Object.assign(owner, {
    icon,
    _showNotification: (...args) => notifications.push(args),
  });
  return { owner, context, actors, timers, notifications };
}

test('top-bar plus bubble anchors below icon or panel center and cleans each effect on time', () => {
  for (const iconVisible of [true, false])
    for (const animated of [true, false]) {
      const { owner, timers } = feedbackFixture({ iconVisible, animated });
      owner._highlightCopy();
      const flash = owner._copyPanelFlash,
        bubble = owner._copyBubble;
      assert.deepEqual(
        [bubble.x, bubble.y],
        iconVisible ? [970, 42] : [600, 46],
      );
      assert.equal(bubble.reactive, false);
      assert.equal(bubble.can_focus, false);
      assert.equal(flash.reactive, false);
      assert.equal(flash.can_focus, false);
      assert.equal(Boolean(flash.animation), animated);
      assert.equal(timers.get(owner._copyPanelFlashTimer).delay, 350);
      assert.equal(timers.get(owner._copyHighlightTimer).delay, 800);
      timers.get(owner._copyPanelFlashTimer).fn();
      assert.equal(flash.destroyed, true);
      assert.equal(bubble.destroyed, undefined);
      timers.get(owner._copyHighlightTimer).fn();
      assert.equal(bubble.destroyed, true);
      assert.equal(owner._copyPanelFlash, undefined);
      assert.equal(owner._copyBubble, undefined);
    }
});

test('repeated copy cancels previous feedback timers and mode changes remove effects', () => {
  const { owner, context, timers } = feedbackFixture();
  owner._highlightCopy();
  const previous = [owner._copyPanelFlash, owner._copyBubble];
  const previousTimers = [...timers.keys()];
  owner._highlightCopy();
  assert.ok(previous.every((actor) => actor.destroyed));
  assert.ok(previousTimers.every((id) => !timers.has(id)));
  assert.equal(timers.size, 2);
  context.COPY_FEEDBACK = 0;
  owner._highlightCopy();
  assert.equal(timers.size, 0);
  assert.equal(owner._copyBubble, undefined);
});

test('existing copy-feedback notification keeps mode 4 without visual overlays', () => {
  const { owner, actors, notifications } = feedbackFixture({ mode: 4 });
  owner._highlightCopy();
  assert.deepEqual(notifications, [['Copied', '']]);
  assert.equal(actors.length, 0);
});

test('history search treats regex metacharacters as literal text without blocking', () => {
  const [owner, context] = instance(['populateSearchResults'], {
    DS: { TYPE_TEXT: 'text' },
    PAGE_SIZE: 50,
    MAX_VISIBLE_CHARS: 200,
  });
  const text = 'a'.repeat(28) + '!';
  const entry = {
    type: 'text',
    text,
    prevCyclic() {
      return this;
    },
    nextCyclic() {
      return this;
    },
  };
  const matches = [];
  Object.assign(owner, {
    historySection: {
      removeAll() {
        owner.activeHistoryMenuItems = 0;
      },
    },
    entries: { last: () => entry },
    searchEntryFront: entry,
    searchEntryBack: entry,
    _addEntry(item) {
      matches.push(item);
      this.activeHistoryMenuItems++;
      item.menuItem = { label: { set_text: noop } };
    },
    _truncated: (value) => value,
  });
  entry.list = owner.entries;
  context.owner = owner;
  vm.runInContext("owner.populateSearchResults('(a+)+$')", context, {
    timeout: 200,
  });
  assert.equal(matches.length, 0);
  entry.text = 'A literal (a+)+$ example';
  vm.runInContext("owner.populateSearchResults('(a+)+$')", context, {
    timeout: 200,
  });
  assert.equal(matches.length, 1);
});

test('private mode excludes hidden candidates and blocks every paste or copy entry point', () => {
  let commands = 0;
  const [owner] = instance(
    [
      '_visiblePasteCandidates',
      '_activatePasteEntry',
      '_copyPasteEntry',
      '_quickPaste',
      '_quickPasteCommand',
    ],
    {
      PRIVATE_MODE: true,
      runCommand: () => commands++,
    },
  );
  owner.historySection = {
    _getMenuItems: () => [{ entry: { kind: 'command' } }],
  };
  assert.equal(owner._visiblePasteCandidates().length, 0);
  for (const entry of [
    { type: 1, text: 'hidden' },
    { type: 1, pasteSetItem: true, kind: 'command', command: 'must not run' },
  ]) {
    owner._activatePasteEntry(entry);
    owner._copyPasteEntry(entry);
    owner._quickPaste(entry);
    owner._quickPasteCommand(entry, false, false);
  }
  assert.equal(commands, 0);
});

test('a privacy transition cancels a pending text paste before keyboard injection', () => {
  for (const change of ['private', 'epoch']) {
    const timers = [],
      writes = [],
      target = {};
    const [owner, context] = instance(['_quickPaste'], {
      DS: { TYPE_TEXT: 1 },
      global: { display: { focus_window: target } },
      Clipboard: {
        get_text: (_, cb) => cb(null, 'original'),
        set_text: (...args) => writes.push(args),
      },
      St: { ClipboardType: { CLIPBOARD: 1 } },
      GLib: {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        timeout_add: (_, ms, cb) => {
          timers.push(cb);
          return timers.length;
        },
      },
    });
    let ended = 0;
    Object.assign(owner, {
      menu: { isOpen: true },
      _quickPasteKeysAreHeld: () => false,
      _endQuickPasteTracking: () => ended++,
      _sendQuickPasteKeys: () => assert.fail('private paste injected'),
    });
    owner._quickPaste({ type: 1, text: 'chosen' });
    if (change === 'private') context.PRIVATE_MODE = true;
    else owner._clipboardQueryEpoch = 1;
    timers[0]();
    assert.equal(ended, 1);
    assert.equal(writes.length, 0);
  }
});

test('history cleanup subscribes independently and honors cleanup policy after metadata or login failures', async () => {
  const start = source.indexOf('  async _prepareHistorySession(');
  const end = source.indexOf('\n  _saveClearedSessionHistory(', start);
  for (const enabled of [false, true])
    for (const failLogin of [false, true]) {
      let logout;
      const context = vm.createContext({
        _: (x) => x,
        SettingsFields: { CLEAR_ON_LOGOUT: 'cleanup' },
        TextDecoder,
        GLib: {
          file_get_contents: () => [true, new Uint8Array([98, 111, 111, 116])],
          get_user_cache_dir: () => '/tmp',
          build_filenamev: (x) => x.join('/'),
        },
        Gio: {
          DBus: {
            session: {
              signal_subscribe(...args) {
                logout = args.at(-1);
                return 42;
              },
            },
          },
          DBusSignalFlags: { NONE: 0 },
        },
        LoginManager: {
          getLoginManager: () => ({
            getCurrentSessionProxy: async () => {
              if (failLogin) throw new Error('login unavailable');
              return { Id: 'new-login' };
            },
          }),
        },
        HistorySession: class {
          constructor() {
            throw new Error('metadata unavailable');
          }
        },
      });
      const Owner = vm.runInContext(
        '(class {' + source.slice(start, end) + '})',
        context,
      );
      const owner = new Owner();
      let loggedOut = 0;
      Object.assign(owner, {
        extension: { uuid: 'audit' },
        settings: { get_boolean: () => enabled },
        _showNotification: noop,
        _onSessionOver: () => loggedOut++,
      });
      assert.equal(await owner._prepareHistorySession(), enabled);
      assert.equal(owner._sessionOverSignal, 42);
      logout();
      assert.equal(loggedOut, 1);
    }
});

test('deleting a search result preserves filtering and refreshes detached pagination references', () => {
  const dsContext = vm.createContext({});
  const DS = vm.runInContext(
    fs
      .readFileSync(path.join(root, 'dataStructures.js'), 'utf8')
      .replace(/export /g, '') + '\n({LLNode,LinkedList,TYPE_TEXT})',
    dsContext,
  );
  const [owner] = instance(
    [
      '_removeEntry',
      '_refreshHistoryAfterRemoval',
      'populateSearchResults',
      '_navigateNextPage',
    ],
    {
      DS,
      PAGE_SIZE: 50,
      MAX_VISIBLE_CHARS: 200,
      Store: { deleteTextEntry: noop },
    },
  );
  const entries = new DS.LinkedList();
  for (const [id, text] of [
    [1, 'older'],
    [2, 'match newest'],
  ]) {
    const entry = new DS.LLNode();
    Object.assign(entry, { id, text, type: DS.TYPE_TEXT });
    entries.append(entry);
  }
  let rows = [];
  Object.assign(owner, {
    entries,
    searchEntry: { get_text: () => 'match newest' },
    historySection: {
      _getMenuItems: () => rows.map((entry) => ({ entry })),
      removeAll: () => {
        rows = [];
        owner.activeHistoryMenuItems = 0;
      },
    },
    _updateCandidateNumbers: noop,
    _maybeRestoreMenuPages: () => assert.fail('unfiltered rows restored'),
    _truncated: (x) => x,
    _addEntry(entry) {
      rows.push(entry);
      this.activeHistoryMenuItems++;
      entry.menuItem = { label: { set_text: noop }, destroy: noop };
    },
    searchEntryFront: entries.last(),
    searchEntryBack: entries.last(),
  });
  const removed = entries.last();
  owner._removeEntry(removed, true, false);
  assert.equal(rows.length, 0);
  owner._navigateNextPage();
  assert.equal(rows.length, 0);
  owner.searchEntryFront = owner.searchEntryBack = removed;
  owner.populateSearchResults('match newest');
  assert.equal(rows.length, 0);
  owner._removeEntry(entries.last(), true, false);
  owner._navigateNextPage();
  assert.equal(rows.length, 0);
});

test('pruning multiple history entries refreshes the filtered view only once', () => {
  const { owner, context, copy } = historyFixture();
  for (let i = 0; i < 20; i++) copy('entry ' + i);
  let refreshes = 0;
  owner._refreshHistoryAfterRemoval = () => refreshes++;
  context.MAX_REGISTRY_LENGTH = 1;
  owner._pruneOldestEntries();
  assert.equal(owner.entries.length, 1);
  assert.equal(refreshes, 1);
});
