import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Atk from 'gi://Atk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
  Extension,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import * as Store from './store.js';
import * as DS from './dataStructures.js';
import { openConfirmDialog } from './confirmDialog.js';
import { FavoriteNameDialog } from './favoriteNameDialog.js';
import { combineCandidates } from './batchPaste.js';
import SettingsFields from './settingsFields.js';
import { modifierBits, modifierLabel, pasteTarget } from './shortcutModifiers.js';

const Clipboard = St.Clipboard.get_default();
const VirtualKeyboard = (() => {
  let VirtualKeyboard;
  return () => {
    if (!VirtualKeyboard) {
      VirtualKeyboard = Clutter.get_default_backend()
        .get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    return VirtualKeyboard;
  };
})();

const SETTING_KEY_CLEAR_HISTORY = 'clear-history';
const SETTING_KEY_PREV_ENTRY = 'prev-entry';
const SETTING_KEY_NEXT_ENTRY = 'next-entry';
const SETTING_KEY_TOGGLE_MENU = 'toggle-menu';
const SETTING_KEY_PRIVATE_MODE = 'toggle-private-mode';
const INDICATOR_ICON = 'edit-paste-symbolic';

const PAGE_SIZE = 50;
const MAX_VISIBLE_CHARS = 200;

let MAX_REGISTRY_LENGTH;
let MAX_BYTES;
let WINDOW_WIDTH_PERCENTAGE;
let CACHE_ONLY_FAVORITES;
let MOVE_ITEM_FIRST;
let ENABLE_KEYBINDING;
let PRIVATE_MODE;
let NOTIFY_ON_COPY;
let CONFIRM_ON_CLEAR;
let MAX_TOPBAR_LENGTH;
let TOPBAR_DISPLAY_MODE; // 0 - only icon, 1 - only clipboard content, 2 - both, 3 - none
let DISABLE_DOWN_ARROW;
let STRIP_TEXT;
let PASTE_ON_SELECTION;
let PROCESS_PRIMARY_SELECTION;
let ENABLE_TYPEAHEAD_SEARCH;

class ClipboardIndicator extends PanelMenu.Button {
  _init(extension) {
    super._init(0, extension.indicatorName, false);

    this.extension = extension;
    this.settings = extension.getSettings();

    this._shortcutsBindingIds = [];

    const hbox = new St.BoxLayout({
      style_class: 'panel-status-menu-box clipboard-indicator-hbox',
    });
    this.icon = new St.Icon({
      icon_name: INDICATOR_ICON,
      style_class: 'system-status-icon clipboard-indicator-icon',
    });
    hbox.add_child(this.icon);
    this._buttonText = new St.Label({
      text: '',
      y_align: Clutter.ActorAlign.CENTER,
    });
    hbox.add_child(this._buttonText);
    this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
    hbox.add_child(this._downArrow);
    this.add_child(hbox);

    this._fetchSettings();
    this._buildMenu();
    this._updateTopbarLayout();
  }

  destroy() {
    this._destroyed = true;
    this._hideModeHint();
    this._batchSeparatorMenu?.destroy();
    this._clearCopyHighlight();
    if (this._quickPasteInputTimer) {
      GLib.Source.remove(this._quickPasteInputTimer);
      this._quickPasteInputTimer = undefined;
    }
    if (this._quickPasteTimer) {
      GLib.Source.remove(this._quickPasteTimer);
      this._quickPasteTimer = undefined;
    }
    this._finishQuickPaste(false);
    this._disconnectSettings();
    this._unbindShortcuts();
    this._disconnectSelectionListener();

    if (this._initialFocusCallbackId) {
      GLib.Source.remove(this._initialFocusCallbackId);
      this._initialFocusCallbackId = undefined;
    }
    if (this._pasteHackCallbackId) {
      GLib.Source.remove(this._pasteHackCallbackId);
      this._pasteHackCallbackId = undefined;
    }

    super.destroy();
  }

  _buildMenu() {
    this.searchEntry = new St.Entry({
      name: 'searchEntry',
      style_class: 'search-entry ci-history-search-entry',
      can_focus: true,
      hint_text: '履歴を検索…',
      accessible_name: 'クリップボード履歴を検索',
      track_hover: true,
      x_expand: true,
      y_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const header = new St.BoxLayout({style_class: 'ci-search-batch-header'});
    header.set_vertical(true);
    this._searchBatchLine = new St.BoxLayout({style_class: 'ci-search-batch-line'});
    this._searchBatchLine.add_child(this.searchEntry);
    header.add_child(this._searchBatchLine);
    this._batchFallbackLine = new St.BoxLayout({style_class: 'ci-batch-fallback'});
    header.add_child(this._batchFallbackLine);
    this._batchFallbackLine.hide();
    this.menu.box.add_child(header);
    this._buildBatchPasteRow(this._searchBatchLine);
    this._searchBatchLine.connect('notify::allocation', () => this._updateBatchLayout());
    this._batchRow.connect('notify::allocation', () => this._updateBatchLayout());

    this.menu.connect('open-state-changed', (self, open) => {
      if (this._initialFocusCallbackId) {
        GLib.Source.remove(this._initialFocusCallbackId);
        this._initialFocusCallbackId = undefined;
      }
      if (!open && !this.menu.isOpen) {
        this._quickPasteKeysHeld?.clear();
        this._hideModeHint();
        this._batchSeparatorMenu?.close();
      }
      if (open) {
        this._updateCandidateNumbers();
        this._setMenuWidth();
        this.searchEntry.set_text('');
        this._initialFocusCallbackId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          1,
          () => {
            this._initialFocusCallbackId = undefined;
            if (!this.menu.isOpen)
              return GLib.SOURCE_REMOVE;
            const firstCandidate =
              this.historySection._getMenuItems()[0] ||
              this.favoritesSection._getMenuItems()[0];
            global.stage.set_key_focus(firstCandidate || this.searchEntry);
            return false;
          },
        );
      }
    });

    // Create menu sections for items
    // Favorites
    this.favoritesSection = new PopupMenu.PopupMenuSection();

    this.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
    this._favoriteShortcutHeading = new St.Label({
      style_class: 'ci-shortcut-heading', reactive: false, can_focus: false,
    });
    this.scrollViewFavoritesMenuSection.actor.add_child(this._favoriteShortcutHeading);
    const favoritesScrollView = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    favoritesScrollView.add_child(this.favoritesSection.actor);

    this.scrollViewFavoritesMenuSection.actor.add_child(favoritesScrollView);
    this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // History
    this.historySection = new PopupMenu.PopupMenuSection();

    this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
    this._historyShortcutHeading = new St.Label({
      style_class: 'ci-shortcut-heading', reactive: false, can_focus: false,
    });
    this.scrollViewMenuSection.actor.add_child(this._historyShortcutHeading);
    this.historyScrollView = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    this.historyScrollView.add_child(this.historySection.actor);

    this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

    this.menu.addMenuItem(this.scrollViewMenuSection);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const actionsSection = new PopupMenu.PopupMenuSection();
    const actionsBox = new St.BoxLayout({
      style_class: 'ci-history-actions-section',
    });

    actionsSection.actor.add_child(actionsBox);
    this.menu.addMenuItem(actionsSection);
    const prevPage = new PopupMenu.PopupBaseMenuItem();
    prevPage.add_child(
      new St.Icon({
        icon_name: 'go-previous-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    prevPage.add_style_class_name('ci-page-button');
    prevPage.connect('activate', this._navigatePrevPage.bind(this));
    actionsBox.add_child(prevPage);

    const nextPage = new PopupMenu.PopupBaseMenuItem();
    nextPage.add_child(
      new St.Icon({
        icon_name: 'go-next-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    nextPage.add_style_class_name('ci-page-button');
    nextPage.connect('activate', this._navigateNextPage.bind(this));
    actionsBox.add_child(nextPage);

    actionsBox.add_child(new St.BoxLayout({ x_expand: true }));

    this.privateModeMenuItem = this._createModeButton(
      'view-private-symbolic', 'プライベートモード：履歴の記録を停止',
      SettingsFields.PRIVATE_MODE,
    );
    this.keepMenuOpenItem = this._createModeButton(
      'view-pin-symbolic', 'メニューを維持', SettingsFields.KEEP_MENU_OPEN,
    );
    actionsBox.add_child(this.privateModeMenuItem);
    actionsBox.add_child(this.keepMenuOpenItem);
    this._syncModeButtons();
    this._updatePrivateModeState();

    const clearMenuItem = new PopupMenu.PopupBaseMenuItem();
    clearMenuItem.add_child(
      new St.Icon({
        icon_name: 'edit-delete-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    actionsBox.add_child(clearMenuItem);

    const settingsMenuItem = new PopupMenu.PopupBaseMenuItem();
    settingsMenuItem.add_child(
      new St.Icon({
        icon_name: 'emblem-system-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    settingsMenuItem.connect('activate', this._openSettings.bind(this));
    actionsBox.add_child(settingsMenuItem);

    for (const section of [this.historySection, this.favoritesSection]) {
      section.actor.connect('child-added', () => this._updateCandidateNumbers());
      section.actor.connect('child-removed', () => this._updateCandidateNumbers());
    }
    if (ENABLE_KEYBINDING) {
      this._bindShortcuts();
    }
    this._quickPasteKeysHeld = new Set();
    // Track releases before child widgets consume them, and suppress repeats.
    this.menu.actor.connect('captured-event', (_, event) =>
      this._captureQuickPasteKey(event));
    this.menu.actor.connect('key-press-event', (_, event) =>
      this._handleGlobalKeyEvent(event),
    );

    Store.buildClipboardStateFromLog(
      (entries, favoriteEntries, nextId, nextDiskId) => {
        /**
         * This field stores the number of items in the historySection to avoid calling _getMenuItems
         * since that method is slow.
         */
        this.activeHistoryMenuItems = 0;
        /**
         * These two IDs are extremely important: making a mistake with either one breaks the
         * extension. Both IDs are globally unique within compaction intervals. The normal ID is
         * *always* present and valid -- it allows us to build an inverted index so we can find
         * previously copied items in O(1) time. The Disk ID is only present when we cache all
         * entries. This additional complexity is needed to know what the ID of an item is on disk as
         * compared to in memory when we're only caching favorites.
         */
        this.nextId = nextId;
        this.nextDiskId = nextDiskId || nextId;
        /**
         * DS.LinkedList is the actual clipboard history and source of truth. Never use historySection
         * or favoritesSection as the source of truth as these may get outdated during pagination.
         *
         * Entries *may* have a menuItem attached, meaning they are currently visible. On the other
         * hand, menu items must always have an entry attached.
         */
        this.entries = entries;
        this.favoriteEntries = favoriteEntries;

        this.currentlySelectedEntry = entries.last();
        this._restoreFavoritedEntries();
        this._maybeRestoreMenuPages();

        this._settingsChangedId = this.settings.connect(
          'changed',
          this._onSettingsChange.bind(this),
        );

        this.searchEntry
          .get_clutter_text()
          .connect('text-changed', this._onSearchTextChanged.bind(this));
        clearMenuItem.connect('activate', this._removeAll.bind(this));

        this._setupSelectionChangeListener();
      },
    );
  }

  _setMenuWidth() {
    const display = global.display;
    const screen_width = display.get_monitor_geometry(
      display.get_primary_monitor(),
    ).width;

    this.menu.actor.width = screen_width * (WINDOW_WIDTH_PERCENTAGE / 100);
  }

  _handleGlobalKeyEvent(event) {
    return (
      this._handleCtrlSelectKeyEvent(event) ||
      this._handleSettingsKeyEvent(event) ||
      this._handleNavigationKeyEvent(event) ||
      this._handleFocusSearchKeyEvent(event) ||
      this._handleSearchTypeAheadKeyEvent(event)
    );
  }

  _createModeButton(icon, description, key) {
    const button = new St.Button({
      style_class: 'ci-mode-button', can_focus: true,
      accessible_role: Atk.Role.TOGGLE_BUTTON,
      child: new St.Icon({icon_name: icon, style_class: 'popup-menu-icon'}),
    });
    button.modeDescription = description;
    button.connect('clicked', () => {
      this.settings.set_boolean(key, !this.settings.get_boolean(key));
    });
    button.connect('notify::hover', () => {
      if (button.hover)
        this._showModeHint(button);
      else
        this._hideModeHint();
    });
    button.connect('key-focus-in', () => this._showModeHint(button));
    button.connect('key-focus-out', () => this._hideModeHint());
    return button;
  }

  _syncModeButtons() {
    for (const [button, active] of [
      [this.privateModeMenuItem, PRIVATE_MODE], [this.keepMenuOpenItem, this._keepMenuOpen],
    ]) {
      button.accessible_name = `${button.modeDescription}：${active ? 'オン' : 'オフ'}`;
      if (active) {
        button.add_style_pseudo_class('checked');
        button.add_accessible_state(Atk.StateType.CHECKED);
      } else {
        button.remove_style_pseudo_class('checked');
        button.remove_accessible_state(Atk.StateType.CHECKED);
      }
    }
    this._hideModeHint();
  }

  _hideModeHint() {
    this._modeHint?.destroy();
    this._modeHint = undefined;
  }

  _showModeHint(button) {
    this._hideModeHint();
    if (!this.menu.isOpen || this._destroyed)
      return;
    const monitor = Main.layoutManager.findMonitorForActor(button);
    if (!monitor)
      return;
    const hint = new St.Label({text: button.accessible_name,
      style_class: 'ci-copy-bubble', reactive: false, can_focus: false});
    this._modeHint = hint;
    Main.uiGroup.add_child(hint);
    const [, width] = hint.get_preferred_width(-1);
    const [, height] = hint.get_preferred_height(width);
    const [x, y] = button.get_transformed_position();
    hint.set_size(width, height);
    hint.set_position(Math.max(monitor.x + 6,
      Math.min(x, monitor.x + monitor.width - width - 6)),
      Math.max(monitor.y + 6, y - height - 6));
  }

  _captureQuickPasteKey(event) {
    const type = event.type();
    if (!this.menu.isOpen)
      return Clutter.EVENT_PROPAGATE;
    if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
      return Clutter.EVENT_PROPAGATE;
    const code = event.get_key_code();
    if (type === Clutter.EventType.KEY_RELEASE) {
      const tracked = this._quickPasteKeysHeld.delete(code);
      if (tracked && this._quickPasteBusy)
        console.log(this.extension.uuid, 'Quick paste: tracked key released');
      return this._quickPasteBusy ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }
    this._quickPasteKeysHeld.add(code);
    if (this._quickPasteBusy) {
      // Ctrl+0 remains available after the brief injection interval.
      if (modifierBits(event.get_state(), Clutter.ModifierType) === 1 &&
          event.get_key_unicode() === '0')
        this.menu.close();
      return Clutter.EVENT_STOP;
    }
    if (this._isBatchActor(global.stage.get_key_focus()) &&
        !(modifierBits(event.get_state(), Clutter.ModifierType) === 1 &&
          event.get_key_unicode() === '0') &&
        event.get_key_symbol() !== Clutter.KEY_Escape)
      return Clutter.EVENT_PROPAGATE;
    if (this._handleCtrlSelectKeyEvent(event))
      return Clutter.EVENT_STOP;
    const symbol = event.get_key_symbol();
    if (global.stage.get_key_focus() instanceof St.Button &&
        [Clutter.KEY_space, Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(symbol))
      return Clutter.EVENT_PROPAGATE;
    if ([Clutter.KEY_Up, Clutter.KEY_Down,
      Clutter.KEY_KP_Up, Clutter.KEY_KP_Down].includes(symbol) &&
        modifierBits(event.get_state(), Clutter.ModifierType) === 0)
      return Clutter.EVENT_PROPAGATE;
    if ([Clutter.KEY_Control_L, Clutter.KEY_Control_R,
      Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
      Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
      Clutter.KEY_Super_L, Clutter.KEY_Super_R,
      Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
      Clutter.KEY_ISO_Level3_Shift].includes(symbol))
      return Clutter.EVENT_PROPAGATE;
    if (this._isSearchActor(global.stage.get_key_focus()))
      return Clutter.EVENT_PROPAGATE;
    if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(symbol) &&
        modifierBits(event.get_state(), Clutter.ModifierType) === 0) {
      const focused = global.stage.get_key_focus();
      const candidates = [
        ...this.historySection._getMenuItems(),
        ...this.favoritesSection._getMenuItems(),
      ];
      const candidate = candidates.find(item => item === focused);
      if (candidate) {
        this._quickPaste(candidate.entry, true, false, true);
        return Clutter.EVENT_STOP;
      }
      // Preserve Enter activation for action buttons, rather than closing.
      return Clutter.EVENT_PROPAGATE;
    }
    // Keep an explicit route into search while other typing exits paste mode.
    if (event.get_key_unicode() === '/' &&
        modifierBits(event.get_state(), Clutter.ModifierType) === 0) {
      global.stage.set_key_focus(this.searchEntry);
      return Clutter.EVENT_STOP;
    }
    const bits = modifierBits(event.get_state(), Clutter.ModifierType);
    const target = pasteTarget(bits, this._historyPasteModifiers, this._favoritePasteModifiers);
    const digit = event.get_key_unicode();
    if (target && (/^[1-9]$/.test(digit) ||
        ((bits & 4) && code >= 10 && code <= 18)))
      return Clutter.EVENT_STOP;
    this.menu.close();
    // Propagation inside Shell does not forward this already captured key to
    // the Wayland client. Consume it rather than synthesize arbitrary input.
    return Clutter.EVENT_STOP;
  }

  _isSearchActor(actor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current === this.searchEntry)
        return true;
    }
    return false;
  }

  _quickPasteKeysAreHeld() {
    return this._quickPasteKeysHeld.size > 0 ||
      Boolean(global.get_pointer()[2] &
        (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK |
          Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.MOD4_MASK |
          Clutter.ModifierType.SUPER_MASK));
  }

  _suspendQuickPasteInput() {
    this._quickPasteInputReleased = true;
    console.log(this.extension.uuid, 'Quick paste: keys released, injecting paste');
    this.menu.emit('open-state-changed', false);
    global.stage.set_key_focus(null);
  }

  _resumeQuickPasteInput() {
    if (this._quickPasteInputTimer) {
      GLib.Source.remove(this._quickPasteInputTimer);
      this._quickPasteInputTimer = undefined;
    }
    if (!this._quickPasteInputReleased)
      return;
    this._quickPasteInputReleased = false;
    if (!this._destroyed && this.menu.isOpen) {
      this.menu.emit('open-state-changed', true);
      console.log(this.extension.uuid, 'Quick paste: keyboard capture resumed');
    }
  }

  _handleCtrlSelectKeyEvent(event) {
    if (!this.menu.isOpen)
      return;
    const bits = modifierBits(event.get_state(), Clutter.ModifierType);
    const target = pasteTarget(bits, this._historyPasteModifiers, this._favoritePasteModifiers);
    let digit = event.get_key_unicode();
    // Shift changes number-row symbols; Mutter uses XKB codes 10..19.
    const code = event.get_key_code();
    if ((bits & 4) && !/^[0-9]$/.test(digit) && code >= 10 && code <= 19)
      digit = String((code - 9) % 10);
    if (!/^[0-9]$/.test(digit))
      return;
    const index = Number(digit);
    if (index === 0 && bits === 1) {
      if (!this._quickPasteBusy)
        this._openBatchPaste();
      return true;
    }
    // Configured modifiers+0 still close, unless they are Ctrl+0.
    if (index === 0 && target) {
      this.menu.close();
      return true;
    }
    if (!target)
      return;
    const favorite = target === 'favorites';
    if (this._quickPasteBusy) {
      return true;
    }
    if (index <= 0) {
      return;
    }

    const items =
      favorite
        ? this.favoritesSection._getMenuItems()
        : this.historySection._getMenuItems();
    if (index > items.length) {
      return;
    }

    this._quickPasteKeysHeld.add(event.get_key_code());
    console.log(this.extension.uuid, 'Quick paste: shortcut pressed', digit);
    this._quickPaste(items[index - 1].entry, !this._keepMenuOpen);
    return true;
  }

  _updateBatchLayout() {
    const width = this._searchBatchLine.width;
    if (width <= 0)
      return;
    const [, batchWidth] = this._batchRow.get_preferred_width(-1);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const wrap = width < batchWidth + 120 * scale;
    const destination = wrap ? this._batchFallbackLine : this._searchBatchLine;
    if (this._batchRow.get_parent() !== destination) {
      this._batchRow.get_parent().remove_child(this._batchRow);
      destination.add_child(this._batchRow);
    }
    this._batchFallbackLine.visible = wrap;
  }

  _buildBatchPasteRow(actionsBox) {
    const container = new St.BoxLayout({
      style_class: 'ci-batch-row', y_align: Clutter.ActorAlign.CENTER,
    });
    this._batchRow = container;
    this._batchNumbers = new St.Entry({text: '1-9', can_focus: true,
      accessible_name: '一括貼付けの履歴番号', style_class: 'ci-batch-numbers'});
    this._batchNumbers.clutter_text.set_max_length(300);
    this._batchSeparator = '\n';
    const separatorButton = new St.Button({label: '改行 ▾', can_focus: true,
      accessible_name: '区切り文字：改行', style_class: 'ci-batch-choice'});
    const pasteButton = new St.Button({label: '一括貼付け', can_focus: true,
      accessible_name: '指定した履歴を一括貼付け', style_class: 'ci-batch-choice'});
    for (const control of [this._batchNumbers, separatorButton, pasteButton]) {
      control.y_expand = false;
      control.y_align = Clutter.ActorAlign.CENTER;
    }
    container.add_child(this._batchNumbers);
    container.add_child(separatorButton);
    container.add_child(pasteButton);
    actionsBox.add_child(container);
    this._batchError = new St.Label({text: '', style_class: 'ci-batch-error', visible: false});
    this.menu.box.add_child(this._batchError);
    const dropdown = new PopupMenu.PopupMenu(separatorButton, 0.5, St.Side.TOP);
    this._batchSeparatorMenu = dropdown;
    Main.uiGroup.add_child(dropdown.actor);
    dropdown.actor.hide();
    this._batchSeparatorManager = new PopupMenu.PopupMenuManager(this);
    this._batchSeparatorManager.addMenu(dropdown);
    for (const [label, value] of [['改行', '\n'], ['なし', ''], ['半角スペース', ' '],
      [',', ','], [',＋半角スペース', ', '], ['タブ', '\t'],
      ['.', '.'], ['/', '/'], ['|', '|'], [':', ':'], ['&', '&']]) {
      const item = new PopupMenu.PopupMenuItem(label);
      item.connect('activate', () => {
        this._batchSeparator = value;
        separatorButton.set_label(label + ' ▾');
        separatorButton.accessible_name = '区切り文字：' + label;
        dropdown.close();
        global.stage.set_key_focus(separatorButton);
      });
      dropdown.addMenuItem(item);
    }
    separatorButton.connect('clicked', () => dropdown.toggle());
    pasteButton.connect('clicked', () => this._pasteBatch());
    this._batchNumbers.clutter_text.connect('activate', () => this._pasteBatch());
    this._batchNumbers.clutter_text.connect('text-changed', () => {
      this._batchError.hide();
    });
  }

  _isBatchActor(actor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current === this._batchRow)
        return true;
    }
    return false;
  }

  _openBatchPaste() {
    if (!this._quickPasteBusy) {
      global.stage.set_key_focus(this._batchNumbers);
      this._batchNumbers.clutter_text.set_selection(0, -1);
    }
  }

  _pasteBatch() {
    if (this._quickPasteBusy)
      return;
    try {
      const candidates = this.historySection._getMenuItems().map(item => ({text: item.entry.text}));
      const result = combineCandidates(candidates, this._batchNumbers.get_text(), this._batchSeparator);
      this._batchError.hide();
      this._quickPaste({type: DS.TYPE_TEXT, text: result.text}, true);
    } catch (error) {
      this._batchError.set_text(error.message);
      this._batchError.show();
    }
  }

  _quickPaste(entry, closeAfterPaste = false, allowClosedMenu = false, commitSelection = false) {
    if (entry.type !== DS.TYPE_TEXT || !global.display.focus_window) {
      console.log(this.extension.uuid, 'Quick paste skipped: no text entry or focused application');
      return;
    }
    const target = global.display.focus_window;
    const generation = this._clipboardGeneration || 0;
    this._quickPasteBusy = true;
    Clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, original) => {
      if (this._destroyed || (!allowClosedMenu && !this.menu.isOpen) ||
          generation !== (this._clipboardGeneration || 0) || typeof original !== 'string') {
        this._endQuickPasteTracking();
        return;
      }
      let attempts = 0;
      // Wait for the physical shortcut keys to be released before injecting paste.
      this._quickPasteTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
        if (this._quickPasteKeysAreHeld()) {
          if (++attempts < 80)
            return GLib.SOURCE_CONTINUE;
          this._endQuickPasteTracking();
          this._quickPasteTimer = undefined;
          return GLib.SOURCE_REMOVE;
        }
        this._quickPasteTimer = undefined;
        if ((!allowClosedMenu && !this.menu.isOpen) || global.display.focus_window !== target ||
            generation !== (this._clipboardGeneration || 0)) {
          this._endQuickPasteTracking();
          return GLib.SOURCE_REMOVE;
        }
        this._quickPasteState = {
          original, text: entry.text, changed: false, keepClipboard: commitSelection,
        };
        if (this.menu.isOpen)
          this._suspendQuickPasteInput();
        Clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        if (commitSelection) {
          this._moveEntryFirst(entry);
          this._selectEntry(entry, false);
        }
        this._sendQuickPasteKeys(closeAfterPaste);
        // Experimental delay: application clipboard reads are asynchronous.
        this._quickPasteTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
          this._quickPasteTimer = undefined;
          this._finishQuickPaste(true);
          return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  _sendQuickPasteKeys(closeAfterPaste = false) {
    const keyboard = VirtualKeyboard();
    const time = GLib.get_monotonic_time();
    const terminal = /terminal|console|kitty|alacritty|wezterm|ghostty|foot|konsole|xterm|tilix|terminator/i.test(
      Shell.WindowTracker.get_default().get_focus_app()?.get_id() || '',
    );
    keyboard.notify_key(time, 29, Clutter.KeyState.PRESSED);
    if (terminal)
      keyboard.notify_key(time, 42, Clutter.KeyState.PRESSED);
    keyboard.notify_key(time, 47, Clutter.KeyState.PRESSED);
    keyboard.notify_key(time, 47, Clutter.KeyState.RELEASED);
    if (terminal)
      keyboard.notify_key(time, 42, Clutter.KeyState.RELEASED);
    keyboard.notify_key(time, 29, Clutter.KeyState.RELEASED);
    if (closeAfterPaste) {
      this._quickPasteInputReleased = false;
      this.menu.close();
      return;
    }
    // Clipboard transfer does not need the keyboard grab to remain released.
    this._quickPasteInputTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
      this._quickPasteInputTimer = undefined;
      this._resumeQuickPasteInput();
      return GLib.SOURCE_REMOVE;
    });
  }

  _finishQuickPaste(resume) {
    const state = this._quickPasteState;
    if (!state)
      return;
    this._quickPasteState = undefined;
    if (!state.changed && !state.keepClipboard) {
      this._quickPasteRestoring = true;
      Clipboard.set_text(St.ClipboardType.CLIPBOARD, state.original);
      this._quickPasteRestoring = false;
    }
    this._endQuickPasteTracking();
    if (resume)
      this._resumeQuickPasteInput();
  }

  _endQuickPasteTracking() {
    this._quickPasteBusy = false;
    if (this._pendingClipboardCopy) {
      this._pendingClipboardCopy = false;
      if (!this._destroyed)
        this._queryClipboard(true);
    }
  }

  _handleSettingsKeyEvent(event) {
    if (event.get_state() !== 12 || event.get_key_unicode() !== 's') {
      return;
    }

    this._openSettings();
    return true;
  }

  _handleNavigationKeyEvent(event) {
    if (!event.has_control_modifier()) {
      return;
    }

    if (event.get_key_unicode() === 'n') {
      this._navigateNextPage();
    } else if (event.get_key_unicode() === 'p') {
      this._navigatePrevPage();
    } else {
      return;
    }

    return true;
  }

  _handleFocusSearchKeyEvent(event) {
    if (event.get_key_unicode() !== '/') {
      return;
    }

    global.stage.set_key_focus(this.searchEntry);
    return true;
  }

  _handleSearchTypeAheadKeyEvent(event) {
    if (!ENABLE_TYPEAHEAD_SEARCH) {
      return false;
    }

    if (global.stage.get_key_focus() === this.searchEntry) {
      return false;
    }

    if (
      event.has_control_modifier() ||
      event.has_alt_modifier?.() ||
      event.has_super_modifier?.()
    ) {
      return false;
    }

    const keySymbol = event.get_key_symbol();
    if (keySymbol === Clutter.KEY_BackSpace) {
      const currentText = this.searchEntry.get_text();
      if (!currentText) {
        return false;
      }

      global.stage.set_key_focus(this.searchEntry);
      this.searchEntry.set_text(currentText.slice(0, -1));
      return true;
    }

    const unicode = event.get_key_unicode();
    if (!unicode || unicode.length !== 1) {
      return false;
    }

    const codePoint = unicode.charCodeAt(0);
    if (codePoint < 32 || codePoint === 127) {
      return false;
    }

    global.stage.set_key_focus(this.searchEntry);
    this.searchEntry.set_text(this.searchEntry.get_text() + unicode);
    return true;
  }

  _addEntry(entry, selectEntry, updateClipboard, insertIndex) {
    if (!entry.favorite && this.activeHistoryMenuItems >= PAGE_SIZE) {
      const items = this.historySection._getMenuItems();
      const item = items[items.length - 1];
      this._rewriteMenuItem(item, entry);
      this.historySection.moveMenuItem(item, 0);
      this._updateCandidateNumbers();

      if (selectEntry) {
        this._selectEntry(entry, updateClipboard);
      }
      return;
    }

    const menuItem = new PopupMenu.PopupMenuItem('', { hover: false });
    this._setCandidateSelection(menuItem, false);

    menuItem.entry = entry;
    entry.menuItem = menuItem;
    menuItem.shortcutLabel = new St.Label({
      text: '',
      style_class: 'ci-shortcut-number',
      y_align: Clutter.ActorAlign.CENTER,
    });
    menuItem.insert_child_at_index(menuItem.shortcutLabel, 1);
    menuItem.label.connect('notify::text', () => {
      this._setCandidateAccessibleName(menuItem);
    });

    menuItem.connect(
      'activate',
      this._onMenuItemSelectedAndMenuClose.bind(this),
    );
    menuItem.connect('key-press-event', (_, event) =>
      this._handleMenuItemKeyEvent(event, menuItem),
    );

    this._setEntryLabel(menuItem);

    // Favorite button
    const icon_name = entry.favorite
      ? 'starred-symbolic'
      : 'non-starred-symbolic';
    const iconfav = new St.Icon({
      icon_name: icon_name,
      style_class: 'system-status-icon',
    });

    const icofavBtn = new St.Button({
      style_class: 'ci-action-btn',
      can_focus: true,
      child: iconfav,
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
      y_expand: true,
    });

    menuItem.actor.add_child(icofavBtn);
    icofavBtn.connect('clicked', () => {
      this._favoriteToggle(menuItem);
    });

    if (entry.favorite) {
      menuItem.favoriteMoveButtons = [];
      for (const [direction, icon, label] of [
        [-1, 'go-up-symbolic', 'お気に入りを上へ移動'],
        [1, 'go-down-symbolic', 'お気に入りを下へ移動'],
      ]) {
        const button = new St.Button({style_class: 'ci-action-btn',
          can_focus: true, accessible_name: label,
          child: new St.Icon({icon_name: icon, style_class: 'system-status-icon'})});
        menuItem.actor.add_child(button);
        menuItem.favoriteMoveButtons.push([direction, button]);
        button.connect('clicked', () => this._moveFavorite(menuItem, direction));
      }
      const renameButton = new St.Button({
        style_class: 'ci-action-btn', can_focus: true,
        accessible_name: 'お気に入りの名前を編集',
        child: new St.Icon({icon_name: 'document-edit-symbolic',
          style_class: 'system-status-icon'}),
      });
      menuItem.actor.add_child(renameButton);
      renameButton.connect('clicked', () => {
        const target = menuItem.entry;
        this.menu.close();
        const dialog = new FavoriteNameDialog(Store.getFavoriteName(target.text), name => {
          if (this._destroyed || !target.list)
            return;
          Store.setFavoriteName(target.text, name);
          if (target.menuItem)
            this._setEntryLabel(target.menuItem);
        });
        dialog.open();
      });
    }

    // Delete button
    const icon = new St.Icon({
      icon_name: 'edit-delete-symbolic',
      style_class: 'system-status-icon',
    });

    const icoBtn = new St.Button({
      style_class: 'ci-action-btn',
      can_focus: true,
      child: icon,
      x_align: Clutter.ActorAlign.END,
      x_expand: false,
      y_expand: true,
    });

    menuItem.actor.add_child(icoBtn);
    icoBtn.connect('clicked', () => {
      this._deleteEntryAndRestoreLatest(menuItem.entry);
    });

    menuItem.connect('destroy', () => {
      delete menuItem.entry.menuItem;
      if (!menuItem.entry.favorite) {
        this.activeHistoryMenuItems--;
      }
    });
    menuItem.connect('key-focus-in', () => {
      if (!menuItem.entry.favorite) {
        ensureActorVisibleInScrollView(this.historyScrollView, menuItem);
      }
    });

    if (entry.favorite) {
      this.favoritesSection.addMenuItem(menuItem, insertIndex);
    } else {
      this.historySection.addMenuItem(menuItem, insertIndex);

      this.activeHistoryMenuItems++;
    }

    this._updateCandidateNumbers();
    if (selectEntry) {
      this._selectEntry(entry, updateClipboard);
    }
  }

  _handleMenuItemKeyEvent(event, menuItem) {
    if (event.get_key_unicode() === 'f') {
      this._favoriteToggle(menuItem);
    }
    if (event.get_key_code() === 119) {
      const next = menuItem.entry.prev || menuItem.entry.next;
      if (next?.menuItem) {
        global.stage.set_key_focus(next.menuItem);
      }
      this._deleteEntryAndRestoreLatest(menuItem.entry);
    }
  }

  _updateButtonText(entry) {
    if (
      !(TOPBAR_DISPLAY_MODE === 1 || TOPBAR_DISPLAY_MODE === 2) ||
      (entry && entry.type !== DS.TYPE_TEXT)
    ) {
      return;
    }

    if (PRIVATE_MODE) {
      this._buttonText.set_text('…');
    } else if (entry) {
      this._buttonText.set_text(this._truncated(entry.text, MAX_TOPBAR_LENGTH));
    } else {
      this._buttonText.set_text('');
    }
  }

  _setCandidateSelection(item, selected) {
    if (!item)
      return;
    // DOT and NO_DOT reserve the same space and use the same menu padding.
    item.setOrnament(selected ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    item._ornamentIcon.opacity = selected ? 255 : 0;
  }

  _setCandidateAccessibleName(item) {
    const shortcut = item.shortcutLabel?.get_text();
    item.accessible_name = shortcut
      ? `${item.shortcutLabel.shortcutName || shortcut}. ${item.label.get_text()}` : item.label.get_text();
  }

  _updateCandidateNumbers() {
    for (const [section, heading, modifiers] of [
      [this.historySection, this._historyShortcutHeading, this._historyPasteModifiers],
      [this.favoritesSection, this._favoriteShortcutHeading, this._favoritePasteModifiers],
    ]) {
      const items = section._getMenuItems();
      heading.set_text(`${modifierLabel(modifiers)}+数字`);
      heading.visible = items.length > 0;
      items.forEach((item, index) => {
        if (!item.shortcutLabel)
          return;
        item.shortcutLabel.shortcutName = index < 9
          ? `${modifierLabel(modifiers)}+${index + 1}` : '';
        item.shortcutLabel.set_text(index < 9 ? String(index + 1) : '');
        this._setCandidateAccessibleName(item);
        for (const [direction, button] of item.favoriteMoveButtons || []) {
          const enabled = Boolean(direction < 0 ? item.entry.next : item.entry.prev);
          button.reactive = enabled;
          button.can_focus = enabled;
          button.opacity = enabled ? 255 : 80;
        }
      });
    }
  }

  _setEntryLabel(menuItem) {
    const entry = menuItem.entry;
    if (entry.type === DS.TYPE_TEXT) {
      menuItem.label.set_text(this._truncated(
        (entry.favorite && Store.getFavoriteName(entry.text)) || entry.text, MAX_VISIBLE_CHARS));
    } else {
      throw new TypeError('Unknown type: ' + entry.type);
    }
  }

  _moveFavorite(menuItem, direction) {
    if (this._quickPasteBusy)
      return;
    const entry = menuItem.entry;
    const neighbor = direction < 0 ? entry.next : entry.prev;
    if (!entry.favorite || !neighbor)
      return;
    // The displayed order is the reverse of the linked list's order.
    if (direction < 0)
      neighbor.append(entry);
    else
      neighbor.prepend(entry);
    Store.reorderFavorites(this.favoriteEntries.toArray().map(item => item.diskId));
    const visible = this.favoritesSection._getMenuItems();
    const order = this.favoriteEntries.toArray().reverse();
    order.filter(item => visible.includes(item.menuItem)).forEach((item, index) => {
      this.favoritesSection.moveMenuItem(item.menuItem, index);
    });
    this._updateCandidateNumbers();
    global.stage.set_key_focus(menuItem);
  }

  _favoriteToggle(menuItem) {
    const entry = menuItem.entry;
    const wasSelected = this.currentlySelectedEntry?.id === entry.id;

    // Move to front (end of list)
    (entry.favorite ? this.entries : this.favoriteEntries).append(entry);
    this._removeEntry(entry);
    entry.favorite = !entry.favorite;
    this._addEntry(entry, wasSelected, false, 0);
    this._maybeRestoreMenuPages();
    global.stage.set_key_focus(entry.menuItem);

    if (CACHE_ONLY_FAVORITES && !entry.favorite) {
      if (entry.diskId) {
        Store.deleteTextEntry(entry.diskId, true);
        delete entry.diskId;
      }
      return;
    }

    if (entry.diskId) {
      Store.updateFavoriteStatus(entry.diskId, entry.favorite);
    } else {
      entry.diskId = this.nextDiskId++;

      Store.storeTextEntry(entry.text);
      Store.updateFavoriteStatus(entry.diskId, true);
    }
  }

  _removeAll() {
    if (CONFIRM_ON_CLEAR) {
      this._confirmRemoveAll();
    } else {
      this._clearHistory();
    }
  }

  _confirmRemoveAll() {
    const title = _('Clear all?');
    const message = _('Are you sure you want to delete all clipboard items?');
    const sub_message = _('This operation cannot be undone.');

    openConfirmDialog(
      title,
      message,
      sub_message,
      _('Clear'),
      _('Cancel'),
      () => {
        this._clearHistory();
      },
    );
  }

  _clearHistory() {
    if (this.currentlySelectedEntry && !this.currentlySelectedEntry.favorite) {
      this._resetSelectedMenuItem(true);
    }

    // Favorites aren't touched when clearing history
    this.entries = new DS.LinkedList();
    this.historySection.removeAll();

    Store.resetDatabase(this._currentStateBuilder.bind(this));
  }

  _removeEntry(entry, fullyDelete, humanGenerated) {
    if (fullyDelete) {
      if (Store.getFavoriteName(entry.text))
        Store.setFavoriteName(entry.text, '');
      entry.detach();

      if (entry.diskId) {
        Store.deleteTextEntry(entry.diskId, entry.favorite);
      }
    }

    if (entry.id === this.currentlySelectedEntry?.id) {
      this._resetSelectedMenuItem(humanGenerated);
    }
    entry.menuItem?.destroy();
    if (fullyDelete) {
      this._maybeRestoreMenuPages();
    }
  }

  _pruneOldestEntries() {
    let entry = this.entries.head;
    while (
      entry &&
      (this.entries.length > MAX_REGISTRY_LENGTH ||
        this.entries.bytes > MAX_BYTES)
    ) {
      const next = entry.next;
      this._removeEntry(entry, true);
      entry = next;
    }

    Store.maybePerformLogCompaction(this._currentStateBuilder.bind(this));
  }

  _selectEntry(entry, updateClipboard, triggerPaste) {
    this._setCandidateSelection(this.currentlySelectedEntry?.menuItem, false);
    this.currentlySelectedEntry = entry;

    this._setCandidateSelection(entry.menuItem, true);
    this._updateButtonText(entry);
    if (updateClipboard !== false) {
      if (entry.type === DS.TYPE_TEXT) {
        this._setClipboardText(entry.text);
      } else {
        throw new TypeError('Unknown type: ' + entry.type);
      }

      if (PASTE_ON_SELECTION && triggerPaste) {
        this._triggerPasteHack();
      }
    }
  }

  _setClipboardText(text) {
    if (this._debouncing !== undefined) {
      this._debouncing++;
    }

    Clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    Clipboard.set_text(St.ClipboardType.PRIMARY, text);
  }

  _triggerPasteHack() {
    this._pasteHackCallbackId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      1, // Just post to the end of the event loop
      () => {
        const SHIFT_L = 42;
        const INSERT = 110;

        const eventTime = Clutter.get_current_event_time() * 1000;
        VirtualKeyboard().notify_key(
          eventTime,
          SHIFT_L,
          Clutter.KeyState.PRESSED,
        );
        VirtualKeyboard().notify_key(
          eventTime,
          INSERT,
          Clutter.KeyState.PRESSED,
        );
        VirtualKeyboard().notify_key(
          eventTime,
          INSERT,
          Clutter.KeyState.RELEASED,
        );
        VirtualKeyboard().notify_key(
          eventTime,
          SHIFT_L,
          Clutter.KeyState.RELEASED,
        );

        this._pasteHackCallbackId = undefined;
        return false;
      },
    );
  }

  _onMenuItemSelectedAndMenuClose(menuItem) {
    if (this._quickPasteBusy)
      return;
    if (PASTE_ON_SELECTION) {
      this._quickPaste(menuItem.entry, true, false, true);
      return;
    }
    this._moveEntryFirst(menuItem.entry);
    this._selectEntry(menuItem.entry, true, true);
    this.menu.close();
  }

  _resetSelectedMenuItem(resetClipboard) {
    this.currentlySelectedEntry = undefined;
    this._updateButtonText();
    if (resetClipboard) {
      this._setClipboardText('');
    }
  }

  _restoreFavoritedEntries() {
    for (let entry = this.favoriteEntries.last(); entry; entry = entry.prev) {
      this._addEntry(entry);
    }
  }

  _maybeRestoreMenuPages() {
    if (this.activeHistoryMenuItems > 0) {
      return;
    }

    for (
      let entry = this.entries.last();
      entry && this.activeHistoryMenuItems < PAGE_SIZE;
      entry = entry.prev
    ) {
      this._addEntry(entry, this.currentlySelectedEntry === entry);
    }
  }

  /**
   * Our pagination implementation is purposefully "broken." The idea is simply to do no unnecessary
   * work. As a consequence, if a user navigates to some page and then starts copying/moving items,
   * those items will appear on the currently visible page even though they don't belong there. This
   * could kind of be considered a feature since it means you can go back to some cluster of copied
   * items and start copying stuff from the same cluster and have it all show up together.
   *
   * Note that over time (as the user copies items), the page reclamation process will morph the
   * current page into the first page. This is the only way to make the user-visible state match our
   * backing store after changing pages.
   *
   * Also note that the use of `last` and `next` is correct. Menu items are ordered from latest to
   * oldest whereas `entries` is ordered from oldest to latest.
   */
  _navigatePrevPage() {
    if (this.searchEntryFront) {
      this.populateSearchResults(this.searchEntry.get_text(), false);
      return;
    }

    const items = this.historySection._getMenuItems();
    if (items.length === 0) {
      return;
    }

    const start = items[0].entry;
    for (
      let entry = start.nextCyclic(), i = items.length - 1;
      entry !== start && i >= 0;
      entry = entry.nextCyclic()
    ) {
      this._rewriteMenuItem(items[i--], entry);
    }
  }

  _navigateNextPage() {
    if (this.searchEntryFront) {
      this.populateSearchResults(this.searchEntry.get_text(), true);
      return;
    }

    const items = this.historySection._getMenuItems();
    if (items.length === 0) {
      return;
    }

    const start = items[items.length - 1].entry;
    for (
      let entry = start.prevCyclic(), i = 0;
      entry !== start && i < items.length;
      entry = entry.prevCyclic()
    ) {
      this._rewriteMenuItem(items[i++], entry);
    }
  }

  _rewriteMenuItem(item, entry) {
    if (item.entry.id === this.currentlySelectedEntry?.id) {
      this._setCandidateSelection(item, false);
    }

    item.entry = entry;
    entry.menuItem = item;

    this._setEntryLabel(item);
    if (entry.id === this.currentlySelectedEntry?.id) {
      this._setCandidateSelection(item, true);
    }
  }

  _onSearchTextChanged() {
    const query = this.searchEntry.get_text();

    if (!query) {
      this.historySection.removeAll();
      this.favoritesSection.removeAll();

      this.searchEntryFront = this.searchEntryBack = undefined;
      this._restoreFavoritedEntries();
      this._maybeRestoreMenuPages();
      return;
    }

    this.searchEntryFront = this.searchEntryBack = this.entries.last();
    this.populateSearchResults(query);
  }

  populateSearchResults(query, forward) {
    this.historySection.removeAll();
    this.favoritesSection.removeAll();

    if (typeof forward !== 'boolean') {
      forward = true;
    }

    query = query.toLowerCase();
    let searchExp;
    try {
      searchExp = new RegExp(query, 'i');
    } catch {}
    for (const favorite of this.favoriteEntries.toArray().reverse()) {
      const name = Store.getFavoriteName(favorite.text);
      const matches = [name, favorite.text].some(text =>
        text.toLowerCase().includes(query) || (searchExp && searchExp.test(text)));
      if (matches)
        this._addEntry(favorite, favorite === this.currentlySelectedEntry, false);
    }
    if (!this.searchEntryFront)
      return;
    const start = forward ? this.searchEntryFront : this.searchEntryBack;
    let entry = start;

    while (this.activeHistoryMenuItems < PAGE_SIZE) {
      if (entry.type === DS.TYPE_TEXT) {
        let match = entry.text.toLowerCase().indexOf(query);
        if (searchExp && match < 0) {
          match = entry.text.search(searchExp);
        }
        if (match >= 0) {
          this._addEntry(
            entry,
            entry === this.currentlySelectedEntry,
            false,
            forward ? undefined : 0,
          );
          entry.menuItem.label.set_text(
            this._truncated(
              entry.text,
              match - 40,
              match + MAX_VISIBLE_CHARS - 40,
            ),
          );
        }
      } else {
        throw new TypeError('Unknown type: ' + entry.type);
      }

      entry = forward ? entry.prevCyclic() : entry.nextCyclic();
      if (entry === start) {
        break;
      }
    }

    if (forward) {
      this.searchEntryBack = this.searchEntryFront.nextCyclic();
      this.searchEntryFront = entry;
    } else {
      this.searchEntryFront = this.searchEntryBack.prevCyclic();
      this.searchEntryBack = entry;
    }
  }

  _shouldAbortClipboardQuery(kind) {
    if (PRIVATE_MODE) {
      return true;
    }

    return false;
  }

  _queryClipboard(externalCopy = false) {
    if (this._shouldAbortClipboardQuery(St.Clipboard.CLIPBOARD)) {
      return;
    }

    const generation = this._clipboardGeneration || 0;
    Clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
      if (this._destroyed || generation !== (this._clipboardGeneration || 0))
        return;
      this._processClipboardContent(text, true, externalCopy);
    });
  }

  _queryPrimaryClipboard() {
    if (this._shouldAbortClipboardQuery(St.Clipboard.PRIMARY)) {
      return;
    }

    Clipboard.get_text(St.ClipboardType.PRIMARY, (_, text) => {
      const last = this.entries.last();
      text = this._processClipboardContent(text, false);
      if (
        last &&
        text &&
        text.length !== last.text.length &&
        (text.endsWith(last.text) ||
          text.startsWith(last.text) ||
          last.text.endsWith(text) ||
          last.text.startsWith(text))
      ) {
        this._removeEntry(last, true);
      }
    });
  }

  _processClipboardContent(text, selectEntry, externalCopy = false) {
    if (this._quickPasteBusy || this._quickPasteRestoring) {
      if (externalCopy)
        this._pendingClipboardCopy = true;
      return;
    }
    if (!externalCopy && this._debouncing > 0) {
      this._debouncing--;
      return;
    }

    if (STRIP_TEXT && text) {
      text = text.trim();
    }
    if (!text) {
      return;
    }

    let entry =
      this.entries.findTextItem(text) ||
      this.favoriteEntries.findTextItem(text);
    if (entry) {
      const isFirst =
        entry === this.entries.last() || entry === this.favoriteEntries.last();
      if (!isFirst) {
        this._moveEntryFirst(entry, true);
      }
      if (selectEntry && (!isFirst || entry !== this.currentlySelectedEntry)) {
        this._selectEntry(entry, false);
      }
    } else {
      entry = new DS.LLNode();
      entry.id = this.nextId++;
      entry.diskId = CACHE_ONLY_FAVORITES ? undefined : this.nextDiskId++;
      entry.type = DS.TYPE_TEXT;
      entry.text = text;
      entry.favorite = false;
      this.entries.append(entry);
      this._addEntry(entry, selectEntry, false, 0);

      if (!CACHE_ONLY_FAVORITES) {
        Store.storeTextEntry(text);
      }
      this._pruneOldestEntries();
    }

    if (NOTIFY_ON_COPY) {
      this._highlightCopy();
    }

    return text;
  }

  _clearCopyHighlight() {
    if (this._copyHighlightTimer) {
      GLib.Source.remove(this._copyHighlightTimer);
      this._copyHighlightTimer = undefined;
    }
    this.icon.remove_style_class_name('copy-highlight');
    if (this._copyBubble) {
      this._copyBubble.destroy();
      this._copyBubble = undefined;
    }
  }

  _highlightCopy() {
    if (this._destroyed || PRIVATE_MODE || this._quickPasteBusy || this._quickPasteRestoring)
      return;
    this._clearCopyHighlight();
    this.icon.add_style_class_name('copy-highlight');
    const monitor = Main.layoutManager.findMonitorForActor(this);
    if (monitor && this.mapped) {
      this._copyBubble = new St.Label({
        text: 'Copied!',
        style_class: 'ci-copy-bubble',
        reactive: false,
        can_focus: false,
      });
      Main.uiGroup.add_child(this._copyBubble);
      const [, width] = this._copyBubble.get_preferred_width(-1);
      const [, height] = this._copyBubble.get_preferred_height(width);
      const [iconX, iconY] = this.icon.get_transformed_position();
      const [iconWidth, iconHeight] = this.icon.get_transformed_size();
      const margin = 6;
      const x = Math.max(monitor.x + margin, Math.min(
        iconX + iconWidth / 2 - width / 2,
        monitor.x + monitor.width - width - margin));
      const y = Math.max(monitor.y + margin, Math.min(
        iconY + iconHeight + 14,
        monitor.y + monitor.height - height - margin));
      this._copyBubble.set_position(Math.round(x), Math.round(y));
      this._copyBubble.set_size(width, height);
    }
    this._copyHighlightTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      this._copyHighlightTimer = undefined;
      this._clearCopyHighlight();
      return GLib.SOURCE_REMOVE;
    });
  }

  _moveEntryFirst(entry, copiedAgain = false) {
    if ((!MOVE_ITEM_FIRST && !copiedAgain) || entry.favorite) {
      return;
    }

    let menu;
    let entries;
    if (entry.favorite) {
      menu = this.favoritesSection;
      entries = this.favoriteEntries;
    } else {
      menu = this.historySection;
      entries = this.entries;
    }

    if (entry.menuItem) {
      menu.moveMenuItem(entry.menuItem, 0);
      this._updateCandidateNumbers();
    } else {
      this._addEntry(entry, false, false, 0);
    }

    entries.append(entry);
    if (entry.diskId) {
      Store.moveEntryToEnd(entry.diskId);
    }
  }

  _currentStateBuilder() {
    const state = [];

    this.nextDiskId = 1;
    for (const entry of this.favoriteEntries) {
      entry.diskId = this.nextDiskId++;
      state.push(entry);
    }
    for (const entry of this.entries) {
      if (CACHE_ONLY_FAVORITES) {
        delete entry.diskId;
      } else {
        entry.diskId = this.nextDiskId++;
        state.push(entry);
      }
    }

    return state;
  }

  _setupSelectionChangeListener() {
    this._debouncing = 0;

    this.selection = Shell.Global.get().get_display().get_selection();
    this._selectionOwnerChangedId = this.selection.connect(
      'owner-changed',
      (_, selectionType) => {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
          this._clipboardGeneration = (this._clipboardGeneration || 0) + 1;
          if (this._quickPasteRestoring)
            return;
          if (this._quickPasteState) {
            if (this._quickPasteState.owned) {
              this._quickPasteState.changed = true;
              this._pendingClipboardCopy = true;
            }
            this._quickPasteState.owned = true;
            return;
          }
          if (this._quickPasteBusy) {
            this._pendingClipboardCopy = true;
            return;
          }
          this._queryClipboard();
        } else if (
          PROCESS_PRIMARY_SELECTION &&
          selectionType === Meta.SelectionType.SELECTION_PRIMARY
        ) {
          this._queryPrimaryClipboard();
        }
      },
    );
  }

  _disconnectSelectionListener() {
    if (!this._selectionOwnerChangedId) {
      return;
    }

    this.selection.disconnect(this._selectionOwnerChangedId);
    this.selection = undefined;
    this._selectionOwnerChangedId = undefined;
  }

  _deleteEntryAndRestoreLatest(entry) {
    this._removeEntry(entry, true, true);

    if (!this.currentlySelectedEntry) {
      const nextEntry = this.entries.last();
      if (nextEntry) {
        this._selectEntry(nextEntry, true);
      }
    }
  }

  _initNotifSource() {
    if (this._notifSource) {
      return;
    }

    this._notifSource = new MessageTray.Source({
      title: this.extension.indicatorName,
      iconName: INDICATOR_ICON,
    });
    this._notifSource.connect('destroy', () => {
      this._notifSource = undefined;
    });
    Main.messageTray.add(this._notifSource);
  }

  _showNotification(title, message, transformFn) {
    const dndOn = () =>
      !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
        'show-banners',
      );
    if (PRIVATE_MODE || dndOn()) {
      return;
    }

    this._initNotifSource();

    let notification;
    if (this._notifSource.count === 0) {
      notification = new MessageTray.Notification({
        source: this._notifSource,
        title,
        body: message,
        isTransient: true,
      });
    } else {
      notification = this._notifSource.notifications[0];
      notification.set({
        title,
        body: message,
      });
      notification.clearActions();
    }

    if (typeof transformFn === 'function') {
      transformFn(notification);
    }

    this._notifSource.addNotification(notification);
  }

  _updatePrivateModeState() {
    // We hide the history in private mode because it will be out of sync
    // (selected item will not reflect clipboard)
    this.scrollViewMenuSection.actor.visible = !PRIVATE_MODE;
    this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATE_MODE;

    if (PRIVATE_MODE) {
      this.icon.add_style_class_name('private-mode');
      this._updateButtonText();
    } else {
      this.icon.remove_style_class_name('private-mode');
      if (this.currentlySelectedEntry) {
        this._selectEntry(this.currentlySelectedEntry, true);
      } else {
        this._resetSelectedMenuItem(true);
      }
    }
  }

  _fetchSettings() {
    this._keepMenuOpen = this.settings.get_boolean(SettingsFields.KEEP_MENU_OPEN);
    this._historyPasteModifiers = this.settings.get_int(SettingsFields.QUICK_PASTE_MODIFIERS);
    this._favoritePasteModifiers = this.settings.get_int(SettingsFields.FAVORITE_PASTE_MODIFIERS);
    MAX_REGISTRY_LENGTH = this.settings.get_int(SettingsFields.HISTORY_SIZE);
    MAX_BYTES =
      (1 << 20) * this.settings.get_int(SettingsFields.CACHE_FILE_SIZE);
    WINDOW_WIDTH_PERCENTAGE = this.settings.get_int(
      SettingsFields.WINDOW_WIDTH_PERCENTAGE,
    );
    CACHE_ONLY_FAVORITES = this.settings.get_boolean(
      SettingsFields.CACHE_ONLY_FAVORITES,
    );
    MOVE_ITEM_FIRST = this.settings.get_boolean(SettingsFields.MOVE_ITEM_FIRST);
    NOTIFY_ON_COPY = this.settings.get_boolean(SettingsFields.NOTIFY_ON_COPY);
    CONFIRM_ON_CLEAR = this.settings.get_boolean(
      SettingsFields.CONFIRM_ON_CLEAR,
    );
    ENABLE_KEYBINDING = this.settings.get_boolean(
      SettingsFields.ENABLE_KEYBINDING,
    );
    MAX_TOPBAR_LENGTH = this.settings.get_int(
      SettingsFields.TOPBAR_PREVIEW_SIZE,
    );
    TOPBAR_DISPLAY_MODE = this.settings.get_int(
      SettingsFields.TOPBAR_DISPLAY_MODE_ID,
    );
    DISABLE_DOWN_ARROW = this.settings.get_boolean(
      SettingsFields.DISABLE_DOWN_ARROW,
    );
    STRIP_TEXT = this.settings.get_boolean(SettingsFields.STRIP_TEXT);
    PRIVATE_MODE = this.settings.get_boolean(SettingsFields.PRIVATE_MODE);
    PASTE_ON_SELECTION = this.settings.get_boolean(
      SettingsFields.PASTE_ON_SELECTION,
    );
    PROCESS_PRIMARY_SELECTION = this.settings.get_boolean(
      SettingsFields.PROCESS_PRIMARY_SELECTION,
    );
    ENABLE_TYPEAHEAD_SEARCH = this.settings.get_boolean(
      SettingsFields.ENABLE_TYPEAHEAD_SEARCH,
    );
  }

  _onSettingsChange() {
    const prevCacheOnlyFavorites = CACHE_ONLY_FAVORITES;
    const prevPrivateMode = PRIVATE_MODE;

    this._fetchSettings();
    this._updateCandidateNumbers();
    this._syncModeButtons();
    if (!NOTIFY_ON_COPY || PRIVATE_MODE)
      this._clearCopyHighlight();

    if (
      prevCacheOnlyFavorites !== undefined &&
      CACHE_ONLY_FAVORITES !== prevCacheOnlyFavorites
    ) {
      if (CACHE_ONLY_FAVORITES) {
        Store.resetDatabase(this._currentStateBuilder.bind(this));
      } else {
        for (const entry of this.entries) {
          entry.diskId = this.nextDiskId++;
          Store.storeTextEntry(entry.text);
        }
      }
    }

    if (prevPrivateMode !== undefined && PRIVATE_MODE !== prevPrivateMode) {
      this._updatePrivateModeState();
    }

    // Remove old entries in case the registry size changed
    this._pruneOldestEntries();

    // Re-set menu-items labels in case preview size changed
    const resetLabel = (item) => this._setEntryLabel(item);
    this.favoritesSection._getMenuItems().forEach(resetLabel);
    this.historySection._getMenuItems().forEach(resetLabel);

    this._updateTopbarLayout();
    if (this.currentlySelectedEntry) {
      this._updateButtonText(this.currentlySelectedEntry);
    }
    this._setMenuWidth();

    if (ENABLE_KEYBINDING) {
      this._bindShortcuts();
    } else {
      this._unbindShortcuts();
    }
  }

  _bindShortcuts() {
    this._unbindShortcuts();
    this._bindShortcut(SETTING_KEY_CLEAR_HISTORY, () => {
      if (this.entries) {
        this._removeAll();
      }
    });
    this._bindShortcut(SETTING_KEY_PREV_ENTRY, () => {
      if (this.entries) {
        this._previousEntry();
      }
    });
    this._bindShortcut(SETTING_KEY_NEXT_ENTRY, () => {
      if (this.entries) {
        this._nextEntry();
      }
    });
    this._bindShortcut(SETTING_KEY_TOGGLE_MENU, () => this.menu.toggle());
    this._bindShortcut(SETTING_KEY_PRIVATE_MODE, () =>
      this.settings.set_boolean(SettingsFields.PRIVATE_MODE, !PRIVATE_MODE),
    );
  }

  _unbindShortcuts() {
    this._shortcutsBindingIds.forEach((id) => Main.wm.removeKeybinding(id));

    this._shortcutsBindingIds = [];
  }

  _bindShortcut(name, cb) {
    const ModeType = Shell.hasOwnProperty('ActionMode')
      ? Shell.ActionMode
      : Shell.KeyBindingMode;

    Main.wm.addKeybinding(
      name,
      this.settings,
      Meta.KeyBindingFlags.NONE,
      ModeType.ALL,
      cb.bind(this),
    );

    this._shortcutsBindingIds.push(name);
  }

  _updateTopbarLayout() {
    if (TOPBAR_DISPLAY_MODE === 3) {
      this.icon.visible = false;
      this._buttonText.visible = false;

      this._style_class = this.style_class;
      this.style_class = '';
    } else if (this._style_class) {
      this.style_class = this._style_class;
    }

    if (TOPBAR_DISPLAY_MODE === 0) {
      this.icon.visible = true;
      this._buttonText.visible = false;
    }
    if (TOPBAR_DISPLAY_MODE === 1) {
      this.icon.visible = false;
      this._buttonText.visible = true;
    }
    if (TOPBAR_DISPLAY_MODE === 2) {
      this.icon.visible = true;
      this._buttonText.visible = true;
    }
    this._downArrow.visible = !DISABLE_DOWN_ARROW;
  }

  _disconnectSettings() {
    if (!this._settingsChangedId) {
      return;
    }

    this.settings.disconnect(this._settingsChangedId);
    this._settingsChangedId = undefined;
  }

  _openSettings() {
    this.extension.openPreferences();
    this.menu.close();
  }

  _previousEntry() {
    this._selectNextPrevEntry(
      this.currentlySelectedEntry.nextCyclic() || this.entries.head,
    );
  }

  _nextEntry() {
    this._selectNextPrevEntry(
      this.currentlySelectedEntry.prevCyclic() || this.entries.last(),
    );
  }

  _selectNextPrevEntry(entry) {
    if (!entry) {
      return;
    }

    this._selectEntry(entry, true);
    if (entry.type === DS.TYPE_TEXT) {
      this._showNotification(_('Copied'), entry.text);
    }
  }

  _truncated(s, start, end) {
    if (start < 0) {
      start = 0;
    }
    if (!end) {
      end = start;
      start = 0;
    }
    if (end > s.length) {
      end = s.length;
    }

    const includesStart = start === 0;
    const includesEnd = end === s.length;
    const isMiddle = !includesStart && !includesEnd;
    const length = end - start;
    const overflow = s.length > length;

    // Reduce regex search space. If the string is mostly whitespace,
    // we might end up removing too many characters, but oh well.
    s = s.substring(start, end + 100);

    // Remove new lines and extra spaces so the text fits nicely on one line
    s = s.replace(/\s+/g, ' ').trim();

    if (includesStart && overflow) {
      s = s.substring(0, length - 1) + '…';
    }
    if (includesEnd && overflow) {
      s = '…' + s.substring(1, length);
    }
    if (isMiddle) {
      s = '…' + s.substring(1, length - 1) + '…';
    }

    return s;
  }
}

const ClipboardIndicatorObj = GObject.registerClass(ClipboardIndicator);

export default class ClipboardHistoryExtension extends Extension {
  enable() {
    this.indicatorName = `${this.metadata.name} Indicator`;

    Store.init(this.uuid);

    this.clipboardIndicator = new ClipboardIndicatorObj(this);
    Main.panel.addToStatusArea(this.indicatorName, this.clipboardIndicator, 1);
  }

  disable() {
    this.clipboardIndicator.destroy();
    this.clipboardIndicator = undefined;

    Store.destroy();
  }
}
