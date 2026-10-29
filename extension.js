import { _, format } from './i18n.js';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Atk from 'gi://Atk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import * as Store from './store.js';
import * as DS from './dataStructures.js';
import { openConfirmDialog, closeConfirmDialog } from './confirmDialog.js';
import { PasteSets } from './pasteSets.js';
import { PasteSetDialog, PasteSetTargetDialog } from './pasteSetDialog.js';
import { runCommand } from './commandOutput.js';
import { HistorySession } from './historySession.js';
import SettingsFields from './settingsFields.js';
import { modifierBits, modifierLabel } from './shortcutModifiers.js';

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

const SETTING_KEY_TOGGLE_MENU = 'toggle-menu';
const INDICATOR_ICON = 'edit-paste-symbolic';

const PAGE_SIZE = 50;
const MAX_VISIBLE_CHARS = 200;

let MAX_REGISTRY_LENGTH;
let MAX_BYTES;
let WINDOW_WIDTH_PERCENTAGE;
let ENABLE_KEYBINDING;
let PRIVATE_MODE;
let COPY_FEEDBACK;
let CLEAR_ON_LOGOUT;
let MAX_TOPBAR_LENGTH;
let TOPBAR_DISPLAY_MODE; // 0 - only icon, 1 - only clipboard content, 2 - both, 3 - none
let DISABLE_DOWN_ARROW;
let STRIP_TEXT;
let PASTE_ON_SELECTION;
let PROCESS_PRIMARY_SELECTION;

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
      gicon: new Gio.FileIcon({
        file: this.extension.dir
          .get_child('icons')
          .get_child('paste-board-symbolic.svg'),
      }),
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
    if (this._sessionOverSignal) {
      Gio.DBus.session.signal_unsubscribe(this._sessionOverSignal);
      this._sessionOverSignal = undefined;
    }
    this._stopPasteDragFeedback();
    this._pasteInsertionLine?.destroy();
    this._pasteInsertionLine = undefined;
    this._cancelPasteCommand();
    closeConfirmDialog();
    this._hideModeHint();
    this._pasteSetDialog?.destroy();
    if (this._pasteDragEndTimer) {
      GLib.Source.remove(this._pasteDragEndTimer);
      this._pasteDragEndTimer = undefined;
    }
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

    super.destroy();
  }

  _buildMenu() {
    this.searchEntry = new St.Entry({
      name: 'searchEntry',
      style_class: 'search-entry ci-history-search-entry',
      can_focus: true,
      hint_text: _('Search items…'),
      accessible_name: _('Search items in the paste panel'),
      track_hover: true,
      x_expand: true,
      y_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const header = new St.BoxLayout({ style_class: 'ci-search-header' });
    header.add_child(this.searchEntry);
    this.menu.box.add_child(header);
    this._activePasteTab = 'history';
    const tabsScroll = new St.ScrollView({
      style_class: 'ci-paste-tabs',
      x_expand: true,
      reactive: true,
    });
    this._tabsScroll = tabsScroll;
    tabsScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
    tabsScroll.connect('notify::allocation', () =>
      this._updatePasteTabScroll(),
    );
    this._tabsBox = new St.BoxLayout({
      style_class: 'ci-paste-tabs-box',
      x_expand: true,
      reactive: true,
    });
    tabsScroll.add_child(this._tabsBox);
    this._makePasteTabSpaceDropTarget(tabsScroll);
    this._makePasteTabSpaceDropTarget(this._tabsBox);
    this.menu.box.add_child(tabsScroll);
    this.menu.connect('open-state-changed', (self, open) => {
      // PopupMenuManager must receive grab changes, but they are not menu opens.
      if (this._changingPasteGrab || this._destroyed) return;
      if (open && this._pasteSets && this._activePasteTab !== 'history')
        this._switchPasteTab('history');
      if (this._initialFocusCallbackId) {
        GLib.Source.remove(this._initialFocusCallbackId);
        this._initialFocusCallbackId = undefined;
      }
      if (!open && !this.menu.isOpen) {
        this._stopPasteDragFeedback();
        this._cancelPasteCommand();
        this._choosingPasteAction = false;
        this._updatePasteActionChooser();
        this._quickPasteKeysHeld?.clear();
        this._hideModeHint();
      }
      if (open) {
        this._updateCandidateNumbers();
        this._setMenuWidth();
        const wasEmpty = this.entries && !this.searchEntry.get_text();
        this.searchEntry.set_text('');
        // Reopening after pagination must start at the actual clipboard item.
        if (wasEmpty) this._onSearchTextChanged();
        this._initialFocusCallbackId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          1,
          () => {
            this._initialFocusCallbackId = undefined;
            if (!this.menu.isOpen) return GLib.SOURCE_REMOVE;
            const firstCandidate = this._visiblePasteCandidates()[0];
            global.stage.set_key_focus(firstCandidate || this.searchEntry);
            return false;
          },
        );
      }
    });

    // History
    this.historySection = new PopupMenu.PopupMenuSection();

    this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
    this.historyScrollView = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    this.historyScrollView.add_child(this.historySection.actor);

    this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

    this.menu.addMenuItem(this.scrollViewMenuSection);
    this._pasteSetContainer = new PopupMenu.PopupMenuSection();
    this._pasteSetSection = new PopupMenu.PopupMenuSection();
    this._pasteSetScroll = new St.ScrollView({
      style_class: 'ci-history-menu-section',
    });
    this._pasteSetScroll.add_child(this._pasteSetSection.actor);
    this._pasteSetContainer.actor.add_child(this._pasteSetScroll);
    this.menu.addMenuItem(this._pasteSetContainer);
    this._pasteSetContainer.actor.hide();

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const actionsSection = new PopupMenu.PopupMenuSection();
    const actionsBox = new St.BoxLayout({
      style_class: 'ci-history-actions-section',
    });

    actionsSection.actor.add_child(actionsBox);
    this._footerActions = actionsBox;
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
      'view-private-symbolic',
      _('Private mode: pause history recording'),
      SettingsFields.PRIVATE_MODE,
    );
    this.keepMenuOpenItem = this._createModeButton(
      'view-pin-symbolic',
      _('Pin the panel'),
      SettingsFields.KEEP_MENU_OPEN,
    );
    actionsBox.add_child(this.privateModeMenuItem);
    actionsBox.add_child(this.keepMenuOpenItem);
    actionsBox.add_child(
      this._setActionButton('tab-new-symbolic', _('Add a paste set'), () =>
        this._editPasteSetName(),
      ),
    );
    actionsBox.add_child(
      this._setActionButton(
        'document-edit-symbolic',
        _('Edit the current tab'),
        () => this._editCurrentPasteTab(),
      ),
    );
    this._buildPasteActionChooser(actionsSection);
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

    if (ENABLE_KEYBINDING) {
      this._bindShortcuts();
    }
    this._quickPasteKeysHeld = new Set();
    // Track releases before child widgets consume them, and suppress repeats.
    this.menu.actor.connect('captured-event', (_, event) =>
      this._captureQuickPasteKey(event),
    );
    this.menu.actor.connect('key-press-event', (_, event) =>
      this._handleGlobalKeyEvent(event),
    );

    Store.buildClipboardStateFromLog(
      async (entries, archivedEntries, nextId, nextDiskId) => {
        if (this._destroyed) return;
        const discard = await this._prepareHistorySession();
        if (this._destroyed) return;
        if (discard) entries = new DS.LinkedList();
        /**
         * This field stores the number of items in the historySection to avoid calling _getMenuItems
         * since that method is slow.
         */
        this.activeHistoryMenuItems = 0;
        /**
         * These two IDs are extremely important: making a mistake with either one breaks the
         * extension. Both IDs are globally unique within compaction intervals. The normal ID is
         * *always* present and valid -- it allows us to find copied items in O(1) time.
         * Disk IDs are reassigned when the append-only log is compacted.
         */
        this.nextId = nextId;
        this.nextDiskId = nextDiskId || nextId;
        /**
         * DS.LinkedList is the actual clipboard history and source of truth. Never use historySection
         * as the source of truth as it may get outdated during pagination.
         *
         * Entries *may* have a menuItem attached, meaning they are currently visible. On the other
         * hand, menu items must always have an entry attached.
         */
        this.entries = entries;
        this._archivedHistoryEntries = archivedEntries;
        if (discard) this._saveClearedSessionHistory();

        this._currentClipboardEntry = undefined;
        this._maybeRestoreMenuPages();
        this._setupPasteSets();

        this._settingsChangedId = this.settings.connect(
          'changed',
          this._onSettingsChange.bind(this),
        );

        this.searchEntry
          .get_clutter_text()
          .connect('text-changed', this._onSearchTextChanged.bind(this));
        clearMenuItem.connect('activate', this._removeAll.bind(this));

        this._setupSelectionChangeListener();
        this._queryClipboard(true, true);
      },
    );
  }

  async _prepareHistorySession() {
    try {
      const session =
        await LoginManager.getLoginManager().getCurrentSessionProxy();
      if (this._destroyed) return false;
      if (!session?.Id)
        throw new Error(_('Cannot identify the login session.'));
      const [, bytes] = GLib.file_get_contents(
        '/proc/sys/kernel/random/boot_id',
      );
      const identity = `${new TextDecoder().decode(bytes).trim()}:${
        session.Id
      }`;
      this._historySession = new HistorySession(
        GLib.build_filenamev([GLib.get_user_cache_dir(), this.extension.uuid]),
        identity,
        this.settings.get_boolean(SettingsFields.CLEAR_ON_LOGOUT),
      );
      this._sessionOverSignal = Gio.DBus.session.signal_subscribe(
        'org.gnome.SessionManager',
        'org.gnome.SessionManager',
        'SessionOver',
        '/org/gnome/SessionManager',
        null,
        Gio.DBusSignalFlags.NONE,
        () => this._onSessionOver(),
      );
      return this._historySession.discardHistory;
    } catch (error) {
      if (!this._destroyed)
        this._showNotification(
          _('Could not prepare history cleanup on logout'),
          error.message,
        );
      return false;
    }
  }

  _saveClearedSessionHistory() {
    const session = this._historySession;
    Store.resetDatabase(this._currentStateBuilder.bind(this), () => {
      if (this._destroyed || this._historySession !== session) return;
      try {
        session?.cleared();
      } catch (error) {
        this._showNotification(
          _('Could not save session metadata'),
          error.message,
        );
      }
    });
  }

  _onSessionOver() {
    if (this._destroyed || !CLEAR_ON_LOGOUT || !this.entries) return;
    this._loggingOut = true;
    this._cancelPasteCommand();
    try {
      this._historySession?.end();
    } catch (error) {
      console.error(this.extension.uuid, error);
    }
    this._clearCurrentClipboardEntry(false);
    this.entries = new DS.LinkedList();
    this.historySection.removeAll();
    this._saveClearedSessionHistory();
  }

  _setupPasteSets() {
    try {
      this._pasteSets = new PasteSets(
        GLib.build_filenamev([GLib.get_user_config_dir(), this.extension.uuid]),
      );
      this._renderPasteSets();
    } catch (error) {
      this._showNotification(_('Could not load paste sets'), error.message);
      this._tabsBox.hide();
    }
  }

  _visiblePasteCandidates() {
    return (
      this._pasteSets && this._activePasteTab !== 'history'
        ? this._pasteSetSection
        : this.historySection
    )
      ._getMenuItems()
      .filter((item) => item.entry);
  }

  _applyPasteSetVisibility() {
    if (!this._pasteSets) return;
    const history = this._activePasteTab === 'history';
    this.scrollViewMenuSection.actor.visible = history && !PRIVATE_MODE;
    this._pasteSetContainer.actor.visible = !history && !PRIVATE_MODE;
  }

  _switchPasteTab(id) {
    if (this._quickPasteBusy) return;
    this._activePasteTab = id;
    this.searchEntry.set_text('');
    this._renderPasteSets();
    if (id === 'history') {
      this.historySection.removeAll();
      this.searchEntryFront = this.searchEntryBack = undefined;
      this._maybeRestoreMenuPages();
    }
    if (this._initialFocusCallbackId)
      GLib.Source.remove(this._initialFocusCallbackId);
    this._initialFocusCallbackId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      1,
      () => {
        this._initialFocusCallbackId = undefined;
        if (this.menu.isOpen && !this._destroyed) {
          const first = this._visiblePasteCandidates()[0];
          global.stage.set_key_focus(first || this.searchEntry);
        }
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _updatePasteTabScroll() {
    if (!this._tabsScroll || this._tabsScroll.width <= 0) return;
    const [, natural] = this._tabsBox.get_preferred_width(-1);
    const policy =
      natural > this._tabsScroll.width + 1
        ? St.PolicyType.AUTOMATIC
        : St.PolicyType.NEVER;
    if (this._tabsScroll.hscrollbar_policy !== policy)
      this._tabsScroll.set_policy(policy, St.PolicyType.NEVER);
  }

  _cyclePasteTab(direction) {
    if (!this._pasteSets || this._quickPasteBusy) return;
    const ids = ['history', ...this._pasteSets.data.sets.map((set) => set.id)];
    const current = Math.max(0, ids.indexOf(this._activePasteTab));
    this._switchPasteTab(ids[(current + direction + ids.length) % ids.length]);
  }

  _makePasteItemDraggable(row) {
    row.pasteDragOwner = this;
    row.getPasteDragContent = () => ({
      text: row.entry.text,
      name: row.entry.name || '',
      sourceSetId: row.entry.sourceSetId,
      id: row.entry.id,
      kind: row.entry.kind || 'text',
      command: row.entry.command,
      executionMode: row.entry.executionMode || 'direct',
      trimTrailingNewlines: row.entry.trimTrailingNewlines,
    });
    row.getDragActor = () =>
      new St.Label({
        text: this._truncated(row.label.get_text(), 60),
        style_class: 'ci-paste-drag-label',
      });
    row.getDragActorSource = () => row.label;
    const draggable = DND.makeDraggable(row, { dragActorOpacity: 220 });
    draggable.connect('drag-begin', () => {
      this._hideModeHint();
      this._draggingPasteItem = true;
      this._stopPasteDragFeedback();
      this._pasteDragMonitor = {
        dragMotion: () => {
          this._clearPasteDropHighlight();
          return DND.DragMotionResult.CONTINUE;
        },
      };
      DND.addDragMonitor(this._pasteDragMonitor);
      // Follow scrolling and popup movement without contributing to row layout.
      this._pasteInsertionTimer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        33,
        () => {
          this._updatePasteInsertionLine();
          return GLib.SOURCE_CONTINUE;
        },
      );
    });
    draggable.connect('drag-end', () => {
      this._stopPasteDragFeedback();
      if (this._pasteDragEndTimer) GLib.Source.remove(this._pasteDragEndTimer);
      this._pasteDragEndTimer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        1,
        () => {
          this._pasteDragEndTimer = undefined;
          this._draggingPasteItem = false;
          if (!this._destroyed) {
            this._clearPasteDropHighlight();
            if (this._pasteDropChanged) {
              this._pasteDropChanged = false;
              const created = this._pasteDropNewTab;
              this._pasteDropNewTab = undefined;
              if (created) this._switchPasteTab(created);
              else this._renderPasteSets();
            }
          }
          return GLib.SOURCE_REMOVE;
        },
      );
    });
  }

  _clearPasteDropHighlight() {
    this._tabsBox
      ?.get_children()
      .forEach((tab) => tab.remove_style_pseudo_class('drop'));
    this._tabsScroll?.remove_style_pseudo_class('drop-new');
    this._pasteDropPlacement = undefined;
    this._pasteInsertionLine?.hide();
  }

  _stopPasteDragFeedback() {
    if (this._pasteDragMonitor) {
      DND.removeDragMonitor(this._pasteDragMonitor);
      this._pasteDragMonitor = undefined;
    }
    if (this._pasteInsertionTimer) {
      GLib.Source.remove(this._pasteInsertionTimer);
      this._pasteInsertionTimer = undefined;
    }
    this._clearPasteDropHighlight();
  }

  _showPasteInsertionLine(row, after) {
    if (!this._pasteInsertionLine) {
      this._pasteInsertionLine = new St.Widget({
        style_class: 'ci-paste-insertion-line',
        reactive: false,
        can_focus: false,
      });
      Main.uiGroup.add_child(this._pasteInsertionLine);
    }
    this._pasteDropPlacement = { row, after };
    this._updatePasteInsertionLine();
  }

  _updatePasteInsertionLine() {
    const placement = this._pasteDropPlacement;
    if (!placement) return;
    const rows = this._pasteSetSection
      ._getMenuItems()
      .filter((item) => item.entry);
    const index = rows.indexOf(placement.row);
    if (index < 0 || !this.menu.isOpen || !this._pasteSetScroll.mapped) {
      this._clearPasteDropHighlight();
      return;
    }
    const [x, y] = placement.row.get_transformed_position();
    const [width, height] = placement.row.get_transformed_size();
    const neighbor = rows[index + (placement.after ? 1 : -1)];
    let boundary = placement.after ? y + height : y;
    if (neighbor) {
      const [, otherY] = neighbor.get_transformed_position();
      const [, otherHeight] = neighbor.get_transformed_size();
      boundary =
        (boundary + (placement.after ? otherY : otherY + otherHeight)) / 2;
    }
    const [clipX, clipY] = this._pasteSetScroll.get_transformed_position();
    const [clipWidth, clipHeight] = this._pasteSetScroll.get_transformed_size();
    const left = Math.max(x + 8, clipX);
    const right = Math.min(x + width - 8, clipX + clipWidth);
    if (
      boundary < clipY ||
      boundary > clipY + clipHeight ||
      right <= left ||
      clipHeight < 2
    ) {
      this._pasteInsertionLine.hide();
      return;
    }
    this._pasteInsertionLine.set_position(
      Math.round(left),
      Math.round(
        Math.max(clipY, Math.min(boundary - 1, clipY + clipHeight - 2)),
      ),
    );
    this._pasteInsertionLine.set_size(Math.round(right - left), 2);
    this._pasteInsertionLine.show();
  }

  _makePasteItemDropTarget(row) {
    const canDrop = (source) =>
      !this._quickPasteBusy &&
      source?.pasteDragOwner === this &&
      typeof source.getPasteDragContent === 'function' &&
      source.getPasteDragContent().sourceSetId === row.entry.sourceSetId &&
      source.getPasteDragContent().id !== row.entry.id;
    // PopupMenuItem already delegates to itself; retain its activation behavior.
    row.handleDragOver = (source, actor, x, y) => {
      this._clearPasteDropHighlight();
      if (!canDrop(source)) return DND.DragMotionResult.NO_DROP;
      this._showPasteInsertionLine(row, y >= row.height / 2);
      return DND.DragMotionResult.MOVE_DROP;
    };
    row.acceptDrop = (source, actor, x, y) => {
      if (!canDrop(source)) return false;
      try {
        this._pasteSets.moveRelative(
          row.entry.sourceSetId,
          source.getPasteDragContent().id,
          row.entry.id,
          y >= row.height / 2,
        );
        this._pasteDropChanged = true;
        return true;
      } catch (error) {
        this._showNotification(_('Could not move the item'), error.message);
        return false;
      }
    };
    row.connect('destroy', () => {
      if (this._pasteDropPlacement?.row === row)
        this._clearPasteDropHighlight();
    });
  }

  _canDropPasteItem(source, setId) {
    return (
      !this._quickPasteBusy &&
      source?.pasteDragOwner === this &&
      typeof source.getPasteDragContent === 'function' &&
      setId !== 'history' &&
      source.getPasteDragContent().sourceSetId !== setId &&
      Boolean(this._pasteSets?.data.sets.some((set) => set.id === setId))
    );
  }

  _makePasteTabDropTarget(button, setId) {
    button._delegate = {
      handleDragOver: (source) => {
        this._clearPasteDropHighlight();
        if (!this._canDropPasteItem(source, setId))
          return DND.DragMotionResult.NO_DROP;
        button.add_style_pseudo_class('drop');
        return DND.DragMotionResult.COPY_DROP;
      },
      acceptDrop: (source) => {
        if (!this._canDropPasteItem(source, setId)) return false;
        const item = source.getPasteDragContent();
        try {
          this._pasteSets.put(setId, { ...item, id: undefined });
          this._pasteDropChanged = true;
          return true;
        } catch (error) {
          this._showNotification(
            _('Could not add to the paste set'),
            error.message,
          );
          return false;
        }
      },
    };
  }

  _isPasteTabSpace(actor, x, y) {
    if (
      actor.width <= 0 ||
      actor.height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= actor.width ||
      y >= actor.height
    )
      return false;
    const [left, top] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    const stageX = left + (x * width) / actor.width;
    const stageY = top + (y * height) / actor.height;
    const [inside, sx, sy] = this._tabsScroll.transform_stage_point(
      stageX,
      stageY,
    );
    if (
      !inside ||
      sx < 0 ||
      sy < 0 ||
      sx >= this._tabsScroll.width ||
      sy >= this._tabsScroll.height
    )
      return false;
    // Failed drops onto existing tabs must not bubble into new-tab creation.
    return !this._tabsBox.get_children().some((tab) => {
      const [valid, tx, ty] = tab.transform_stage_point(stageX, stageY);
      return valid && tx >= 0 && ty >= 0 && tx < tab.width && ty < tab.height;
    });
  }

  _makePasteTabSpaceDropTarget(actor) {
    const canDrop = (source, x, y) =>
      !this._destroyed &&
      !PRIVATE_MODE &&
      !this._quickPasteBusy &&
      Boolean(this._pasteSets) &&
      source?.pasteDragOwner === this &&
      typeof source.getPasteDragContent === 'function' &&
      this._isPasteTabSpace(actor, x, y);
    actor._delegate = {
      handleDragOver: (source, dragActor, x, y) => {
        this._clearPasteDropHighlight();
        if (!canDrop(source, x, y)) return DND.DragMotionResult.NO_DROP;
        this._tabsScroll.add_style_pseudo_class('drop-new');
        return DND.DragMotionResult.COPY_DROP;
      },
      acceptDrop: (source, dragActor, x, y) => {
        if (!canDrop(source, x, y)) return false;
        try {
          this._pasteDropNewTab = this._pasteSets.createFromItem(
            source.getPasteDragContent(),
          );
          this._pasteDropChanged = true;
          return true;
        } catch (error) {
          this._showNotification(
            _('Could not create the paste set'),
            error.message,
          );
          return false;
        }
      },
    };
  }

  _setActionButton(icon, name, action) {
    const button = new St.Button({
      can_focus: true,
      accessible_name: name,
      style_class: 'ci-mode-button',
      child: new St.Icon({ icon_name: icon, style_class: 'popup-menu-icon' }),
    });
    button.connect('clicked', action);
    button.connect('notify::hover', () =>
      button.hover ? this._showModeHint(button) : this._hideModeHint(),
    );
    button.connect('key-focus-in', () => this._showModeHint(button));
    button.connect('key-focus-out', () => this._hideModeHint());
    return button;
  }

  _renderPasteSets() {
    if (!this._pasteSets) return;
    this._clearPasteDropHighlight();
    const sets = this._pasteSets.data.sets;
    if (
      this._activePasteTab !== 'history' &&
      !sets.some((set) => set.id === this._activePasteTab)
    )
      this._activePasteTab = 'history';
    this._tabsBox.get_children().forEach((actor) => actor.destroy());
    for (const [id, name] of [
      ['history', this._pasteSets.data.historyName || _('History')],
      ...sets.map((set) => [set.id, set.name]),
    ]) {
      const button = new St.Button({
        can_focus: true,
        accessible_role: Atk.Role.PAGE_TAB,
        accessible_name: name,
        style_class: 'ci-paste-tab',
      });
      const tabContent = new St.BoxLayout({
        style_class: 'ci-paste-tab-content',
      });
      tabContent.set_vertical(true);
      tabContent.add_child(new St.Label({ text: name }));
      tabContent.add_child(
        new St.Widget({ style_class: 'ci-tab-underline', x_expand: true }),
      );
      button.set_child(tabContent);
      if (id === this._activePasteTab) {
        button.add_style_pseudo_class('checked');
        button.add_accessible_state(Atk.StateType.SELECTED);
      }
      this._makePasteTabDropTarget(button, id);
      button.connect('clicked', () => this._switchPasteTab(id));
      this._tabsBox.add_child(button);
    }
    this._pasteSetSection.removeAll();
    const set = sets.find((item) => item.id === this._activePasteTab);
    const query = this.searchEntry.get_text().toLowerCase();
    if (set) {
      const items = set.items.filter(
        (item) =>
          !query ||
          item.name.toLowerCase().includes(query) ||
          (item.kind === 'command' ? item.command : item.text)
            .toLowerCase()
            .includes(query),
      );
      items.forEach((item, index) => {
        const row = new PopupMenu.PopupMenuItem(
          item.name ||
            this._truncated(
              item.kind === 'command' ? item.command : item.text,
              MAX_VISIBLE_CHARS,
            ),
          { hover: false },
        );
        row.add_style_class_name('ci-clipboard-row');
        row.label.x_expand = true;
        this._hideCandidateOrnament(row);
        row.entry = {
          ...item,
          type: DS.TYPE_TEXT,
          sourceSetId: set.id,
          pasteSetItem: true,
        };
        if (item.kind === 'command')
          row.insert_child_at_index(
            new St.Icon({
              icon_name: 'utilities-terminal-symbolic',
              style_class: 'popup-menu-icon',
            }),
            1,
          );
        this._makePasteItemDraggable(row);
        this._makePasteItemDropTarget(row);
        row.connect('key-focus-in', () =>
          ensureActorVisibleInScrollView(this._pasteSetScroll, row),
        );
        row.shortcutLabel = new St.Label({
          style_class: 'ci-shortcut-number',
          y_align: Clutter.ActorAlign.CENTER,
        });
        row.insert_child_at_index(row.shortcutLabel, 1);
        row.connect('activate', () => {
          // Keep the grab until asynchronous paste releases it itself.
          GObject.signal_stop_emission_by_name(row, 'activate');
          if (!this._quickPasteBusy && !this._draggingPasteItem)
            this._activatePasteEntry(row.entry);
        });
        for (const [icon, label, action, enabled] of [
          [
            'go-up-symbolic',
            _('Move up'),
            () =>
              this._changePasteSet(() =>
                this._pasteSets.move(set.id, item.id, -1),
              ),
            set.items.indexOf(item) > 0,
          ],
          [
            'go-down-symbolic',
            _('Move down'),
            () =>
              this._changePasteSet(() =>
                this._pasteSets.move(set.id, item.id, 1),
              ),
            set.items.indexOf(item) < set.items.length - 1,
          ],
          [
            'document-edit-symbolic',
            _('Edit name and content'),
            () => this._editPasteSetItem(set.id, item),
            true,
          ],
          [
            'edit-delete-symbolic',
            _('Delete item'),
            () => this._confirmPasteSetDelete(set.id, item),
            true,
          ],
        ]) {
          const button = this._setActionButton(icon, label, action);
          button.set_style_class_name('ci-action-btn');
          button.reactive = button.can_focus = enabled;
          button.opacity = enabled ? 255 : 80;
          row.add_child(button);
        }
        this._pasteSetSection.addMenuItem(row);
      });
      if (!items.length) {
        const empty = new PopupMenu.PopupMenuItem(
          query
            ? _('No matching items')
            : _('Drag a history item onto this tab to add it'),
          { reactive: false, can_focus: false },
        );
        this._pasteSetSection.addMenuItem(empty);
      }
    }
    this._applyPasteSetVisibility();
    this._updateCandidateNumbers();
    this._updatePasteTabScroll();
  }

  _changePasteSet(change) {
    if (this._quickPasteBusy || this._destroyed) return;
    try {
      change();
      this._renderPasteSets();
    } catch (error) {
      this._showNotification(_('Could not save paste sets'), error.message);
    }
  }

  _openPasteSetDialog(dialog) {
    if (this._quickPasteBusy || this._destroyed) {
      dialog.destroy();
      return;
    }
    this.menu.close();
    this._pasteSetDialog?.destroy();
    this._pasteSetDialog = dialog;
    dialog.connect('closed', () => {
      if (this._pasteSetDialog === dialog) this._pasteSetDialog = undefined;
    });
    dialog.open();
  }

  _editCurrentPasteTab() {
    if (!this._pasteSets || this._quickPasteBusy) return;
    const id = this._activePasteTab;
    const set = this._pasteSets.data.sets.find((item) => item.id === id);
    const name =
      id === 'history'
        ? this._pasteSets.data.historyName || _('History')
        : set?.name;
    if (!name) return;
    this._openPasteSetDialog(
      new PasteSetDialog(
        _('Edit tab'),
        name,
        null,
        (nextName) => {
          if (this._destroyed) return;
          if (id === 'history') this._pasteSets.renameHistory(nextName);
          else this._pasteSets.rename(id, nextName);
          this._renderPasteSets();
        },
        id === 'history' ? null : () => this._confirmPasteSetDelete(id),
      ),
    );
  }

  _editPasteSetName(id = null, initialText = null) {
    if (!this._pasteSets) return;
    const set = this._pasteSets.data.sets.find((item) => item.id === id);
    this._openPasteSetDialog(
      new PasteSetDialog(
        id ? _('Rename paste set') : _('Create paste set'),
        set?.name || '',
        null,
        (name) => {
          if (this._destroyed) return;
          if (id) this._pasteSets.rename(id, name);
          else {
            // Create and add atomically when capturing a history item.
            const newId = GLib.uuid_string_random();
            this._pasteSets.change((sets) =>
              sets.push({
                id: newId,
                name,
                items:
                  initialText === null
                    ? []
                    : [
                        {
                          id: GLib.uuid_string_random(),
                          name: '',
                          text: initialText,
                        },
                      ],
              }),
            );
            this._activePasteTab = newId;
          }
          this._renderPasteSets();
        },
      ),
    );
  }

  _editPasteSetItem(setId, item = null) {
    this._openPasteSetDialog(
      new PasteSetDialog(
        item ? _('Edit paste item') : _('Add paste item'),
        item?.name || '',
        (item?.kind === 'command' ? item.command : item?.text) || '',
        (name, text, options) => {
          if (this._destroyed) return;
          this._pasteSets.put(setId, {
            id: item?.id,
            name,
            ...options,
            text: options.kind === 'command' ? '' : text,
            command: options.kind === 'command' ? text : undefined,
          });
          this._renderPasteSets();
        },
        null,
        {
          kind: item?.kind || 'text',
          executionMode: item?.executionMode || 'direct',
          trimTrailingNewlines: item?.trimTrailingNewlines !== false,
        },
      ),
    );
  }

  _addToPasteSet(text) {
    if (!this._pasteSets || this._quickPasteBusy) return;
    if (!this._pasteSets.data.sets.length) {
      this._editPasteSetName(null, text);
      return;
    }
    this._openPasteSetDialog(
      new PasteSetTargetDialog(this._pasteSets.data.sets, (id) => {
        if (this._destroyed) return;
        this._pasteSets.put(id, { name: '', text });
        this._renderPasteSets();
      }),
    );
  }

  _confirmPasteSetDelete(setId, item = null) {
    const set = this._pasteSets.data.sets.find((entry) => entry.id === setId);
    if (!set) return;
    this.menu.close();
    openConfirmDialog(
      item ? _('Delete this item?') : _('Delete this paste set?'),
      item ? item.name || _('Selected item') : set.name,
      item
        ? _('This item will be removed from the paste set.')
        : _('All items in this paste set will also be deleted.'),
      _('Delete'),
      _('Cancel'),
      () => {
        if (this._destroyed) return;
        this._changePasteSet(() =>
          item
            ? this._pasteSets.removeItem(setId, item.id)
            : this._pasteSets.remove(setId),
        );
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
      this._handleFocusSearchKeyEvent(event)
    );
  }

  _createModeButton(icon, description, key) {
    const button = new St.Button({
      style_class: 'ci-mode-button',
      can_focus: true,
      accessible_role: Atk.Role.TOGGLE_BUTTON,
      child: new St.Icon({ icon_name: icon, style_class: 'popup-menu-icon' }),
    });
    button.modeDescription = description;
    button.connect('clicked', () => {
      if (key === SettingsFields.KEEP_MENU_OPEN) {
        if (this._quickPasteBusy) return;
        if (this._keepMenuOpen) {
          this._choosingPasteAction = false;
          this.settings.set_boolean(key, false);
        } else {
          this._pasteAfterAction = 'none';
          this._choosingPasteAction = false;
          this.settings.set_boolean(key, true);
        }
      } else {
        this.settings.set_boolean(key, !this.settings.get_boolean(key));
      }
    });
    button.connect('notify::hover', () => {
      if (button.hover) this._showModeHint(button);
      else this._hideModeHint();
    });
    button.connect('key-focus-in', () => this._showModeHint(button));
    button.connect('key-focus-out', () => this._hideModeHint());
    return button;
  }

  _buildPasteActionChooser(section) {
    this._pasteAfterAction = 'none';
    this._pasteActionRow = new St.BoxLayout({
      style_class: 'ci-paste-action-row',
    });
    this._pasteActionRow.add_child(
      new St.Label({
        text: _('After paste'),
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._pasteActionButtons = [];
    for (const [value, label] of [
      ['none', _('No action')],
      ['enter', 'Enter'],
      ['tab', 'Tab'],
    ]) {
      const button = new St.Button({
        label,
        can_focus: true,
        style_class: 'ci-paste-action-choice',
        accessible_role: Atk.Role.TOGGLE_BUTTON,
        accessible_name:
          value === 'none'
            ? _('No key after paste')
            : format(_('Send %s after paste'), label),
      });
      button.connect('clicked', () => {
        if (this._quickPasteBusy) return;
        this._pasteAfterAction = value;
        this._choosingPasteAction = false;
        if (!this._keepMenuOpen)
          this.settings.set_boolean(SettingsFields.KEEP_MENU_OPEN, true);
        this._updatePasteActionChooser();
      });
      this._pasteActionButtons.push([value, button]);
      this._pasteActionRow.add_child(button);
    }
    section.actor.add_child(this._pasteActionRow);
  }

  _updatePasteActionChooser() {
    if (!this._pasteActionRow) return;
    if (!this._keepMenuOpen && !this._choosingPasteAction)
      this._pasteAfterAction = 'none';
    this._pasteActionRow.visible = Boolean(
      this._keepMenuOpen || this._choosingPasteAction,
    );
    for (const [value, button] of this._pasteActionButtons) {
      if (value === this._pasteAfterAction) {
        button.add_style_pseudo_class('checked');
        button.add_accessible_state(Atk.StateType.CHECKED);
      } else {
        button.remove_style_pseudo_class('checked');
        button.remove_accessible_state(Atk.StateType.CHECKED);
      }
    }
  }

  _syncModeButtons() {
    this._updatePasteActionChooser();
    for (const [button, active] of [
      [this.privateModeMenuItem, PRIVATE_MODE],
      [this.keepMenuOpenItem, this._keepMenuOpen],
    ]) {
      button.accessible_name = format(
        _('%s: %s'),
        button.modeDescription,
        active ? _('On') : _('Off'),
      );
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
    if (!this.menu.isOpen || this._destroyed) return;
    const monitor = Main.layoutManager.findMonitorForActor(button);
    if (!monitor) return;
    const hint = new St.Label({
      text: button.accessible_name,
      style_class: 'ci-copy-bubble',
      reactive: false,
      can_focus: false,
    });
    this._modeHint = hint;
    Main.uiGroup.add_child(hint);
    const [, width] = hint.get_preferred_width(-1);
    const [, height] = hint.get_preferred_height(width);
    const [x, y] = button.get_transformed_position();
    hint.set_size(width, height);
    hint.set_position(
      Math.max(
        monitor.x + 6,
        Math.min(x, monitor.x + monitor.width - width - 6),
      ),
      Math.max(monitor.y + 6, y - height - 6),
    );
  }

  _captureQuickPasteKey(event) {
    const type = event.type();
    if (!this.menu.isOpen) return Clutter.EVENT_PROPAGATE;
    if (
      type !== Clutter.EventType.KEY_PRESS &&
      type !== Clutter.EventType.KEY_RELEASE
    )
      return Clutter.EVENT_PROPAGATE;
    const code = event.get_key_code();
    if (type === Clutter.EventType.KEY_RELEASE) {
      const tracked = this._quickPasteKeysHeld.delete(code);
      if (tracked && this._quickPasteBusy)
        console.log(this.extension.uuid, 'Quick paste: tracked key released');
      return this._quickPasteBusy
        ? Clutter.EVENT_STOP
        : Clutter.EVENT_PROPAGATE;
    }
    this._quickPasteKeysHeld.add(code);
    if (this._quickPasteBusy) {
      // Allow closing while a command or paste is in progress.
      const bits = modifierBits(event.get_state(), Clutter.ModifierType);
      if (
        event.get_key_symbol() === Clutter.KEY_Escape ||
        ((bits === 1 || bits === this._historyPasteModifiers) &&
          event.get_key_unicode() === '0')
      )
        this.menu.close();
      return Clutter.EVENT_STOP;
    }
    if (this._handleCtrlSelectKeyEvent(event)) return Clutter.EVENT_STOP;
    const symbol = event.get_key_symbol();
    if (
      this._pasteSets &&
      [
        Clutter.KEY_Left,
        Clutter.KEY_Right,
        Clutter.KEY_KP_Left,
        Clutter.KEY_KP_Right,
      ].includes(symbol) &&
      modifierBits(event.get_state(), Clutter.ModifierType) === 0 &&
      !this._isSearchActor(global.stage.get_key_focus())
    ) {
      this._cyclePasteTab(
        [Clutter.KEY_Left, Clutter.KEY_KP_Left].includes(symbol) ? -1 : 1,
      );
      return Clutter.EVENT_STOP;
    }
    if (
      [Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab].includes(symbol) &&
      (modifierBits(event.get_state(), Clutter.ModifierType) & ~4) === 0
    ) {
      const backward =
        symbol === Clutter.KEY_ISO_Left_Tab ||
        Boolean(modifierBits(event.get_state(), Clutter.ModifierType) & 4);
      return this._focusNextMenuControl(backward)
        ? Clutter.EVENT_STOP
        : Clutter.EVENT_PROPAGATE;
    }
    if (
      global.stage.get_key_focus() instanceof St.Button &&
      [Clutter.KEY_space, Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(
        symbol,
      )
    )
      return Clutter.EVENT_PROPAGATE;
    if (
      [
        Clutter.KEY_Up,
        Clutter.KEY_Down,
        Clutter.KEY_KP_Up,
        Clutter.KEY_KP_Down,
      ].includes(symbol) &&
      modifierBits(event.get_state(), Clutter.ModifierType) === 0
    )
      return Clutter.EVENT_PROPAGATE;
    if (
      [
        Clutter.KEY_Control_L,
        Clutter.KEY_Control_R,
        Clutter.KEY_Shift_L,
        Clutter.KEY_Shift_R,
        Clutter.KEY_Alt_L,
        Clutter.KEY_Alt_R,
        Clutter.KEY_Super_L,
        Clutter.KEY_Super_R,
        Clutter.KEY_Meta_L,
        Clutter.KEY_Meta_R,
        Clutter.KEY_ISO_Level3_Shift,
      ].includes(symbol)
    )
      return Clutter.EVENT_PROPAGATE;
    if (this._isSearchActor(global.stage.get_key_focus()))
      return Clutter.EVENT_PROPAGATE;
    if (
      [Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(symbol) &&
      modifierBits(event.get_state(), Clutter.ModifierType) === 0
    ) {
      const focused = global.stage.get_key_focus();
      const candidates = this._visiblePasteCandidates();
      const candidate = candidates.find((item) => item === focused);
      if (candidate) {
        this._activatePasteEntry(candidate.entry);
        return Clutter.EVENT_STOP;
      }
      // Preserve Enter activation for action buttons, rather than closing.
      return Clutter.EVENT_PROPAGATE;
    }
    // Keep an explicit route into search while other typing exits paste mode.
    if (
      event.get_key_unicode() === '/' &&
      modifierBits(event.get_state(), Clutter.ModifierType) === 0
    ) {
      global.stage.set_key_focus(this.searchEntry);
      return Clutter.EVENT_STOP;
    }
    const bits = modifierBits(event.get_state(), Clutter.ModifierType);
    const target = bits === this._historyPasteModifiers ? 'history' : null;
    const digit = event.get_key_unicode();
    if (
      target &&
      (/^[1-9]$/.test(digit) || (bits & 4 && code >= 10 && code <= 18))
    )
      return Clutter.EVENT_STOP;
    this.menu.close();
    // Propagation inside Shell does not forward this already captured key to
    // the Wayland client. Consume it rather than synthesize arbitrary input.
    return Clutter.EVENT_STOP;
  }

  _focusNextMenuControl(backward) {
    const order = [];
    const collect = (actor) => {
      if (!actor?.visible) return;
      if (actor.can_focus && actor.reactive) {
        order.push(actor);
        return;
      }
      for (const child of actor.get_children()) collect(child);
    };
    collect(this.searchEntry);
    collect(this._tabsBox);
    const rows = this._visiblePasteCandidates();
    for (const row of rows) {
      if (row.visible && row.can_focus && row.reactive) order.push(row);
      for (const child of row.get_children()) collect(child);
    }
    collect(this._footerActions);
    collect(this._pasteActionRow);
    if (!order.length) return false;
    let focused = global.stage.get_key_focus();
    let index = -1;
    while (focused && index < 0) {
      index = order.indexOf(focused);
      focused = focused.get_parent();
    }
    const next =
      index < 0
        ? backward
          ? order[order.length - 1]
          : order[0]
        : order[(index + (backward ? -1 : 1) + order.length) % order.length];
    global.stage.set_key_focus(next);
    const row = rows.find((item) => item === next || item.contains(next));
    if (row)
      ensureActorVisibleInScrollView(
        row.entry.pasteSetItem ? this._pasteSetScroll : this.historyScrollView,
        row,
      );
    return true;
  }

  _isSearchActor(actor) {
    for (let current = actor; current; current = current.get_parent()) {
      if (current === this.searchEntry) return true;
    }
    return false;
  }

  _quickPasteKeysAreHeld() {
    return (
      this._quickPasteKeysHeld.size > 0 ||
      Boolean(
        global.get_pointer()[2] &
          (Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.SHIFT_MASK |
            Clutter.ModifierType.MOD1_MASK |
            Clutter.ModifierType.MOD4_MASK |
            Clutter.ModifierType.SUPER_MASK),
      )
    );
  }

  _suspendQuickPasteInput() {
    this._quickPasteFocusedCandidate = this._focusedHistoryCandidate();
    this._quickPasteInputReleased = true;
    console.log(
      this.extension.uuid,
      'Quick paste: keys released, injecting paste',
    );
    this._emitPasteGrabState(false);
    global.stage.set_key_focus(null);
  }

  _emitPasteGrabState(open) {
    this._changingPasteGrab = true;
    try {
      this.menu.emit('open-state-changed', open);
    } finally {
      this._changingPasteGrab = false;
    }
  }

  _resumeQuickPasteInput() {
    if (this._quickPasteInputTimer) {
      GLib.Source.remove(this._quickPasteInputTimer);
      this._quickPasteInputTimer = undefined;
    }
    if (!this._quickPasteInputReleased) return;
    this._quickPasteInputReleased = false;
    if (!this._destroyed && this.menu.isOpen) {
      this._emitPasteGrabState(true);
      const previous = this._quickPasteFocusedCandidate;
      if (previous && this._focusedHistoryCandidate(previous)) {
        if (this._initialFocusCallbackId) {
          GLib.Source.remove(this._initialFocusCallbackId);
          this._initialFocusCallbackId = undefined;
        }
        global.stage.set_key_focus(previous);
      } else {
        global.stage.set_key_focus(
          this._visiblePasteCandidates()[0] || this.searchEntry,
        );
      }
      console.log(this.extension.uuid, 'Quick paste: keyboard capture resumed');
    }
    this._quickPasteFocusedCandidate = undefined;
  }

  _focusedHistoryCandidate(actor = global.stage.get_key_focus()) {
    return this._visiblePasteCandidates().find((item) => item === actor);
  }

  _handleCtrlSelectKeyEvent(event) {
    if (!this.menu.isOpen) return;
    const bits = modifierBits(event.get_state(), Clutter.ModifierType);
    const target = bits === this._historyPasteModifiers ? 'history' : null;
    let digit = event.get_key_unicode();
    // Shift changes number-row symbols; Mutter uses XKB codes 10..19.
    const code = event.get_key_code();
    if (bits & 4 && !/^[0-9]$/.test(digit) && code >= 10 && code <= 19)
      digit = String((code - 9) % 10);
    if (!/^[0-9]$/.test(digit)) return;
    const index = Number(digit);
    if (index === 0 && (bits === 1 || target)) {
      this.menu.close();
      return true;
    }
    if (!target) return;
    if (this._quickPasteBusy) {
      return true;
    }
    if (index <= 0) {
      return;
    }

    const items = this._visiblePasteCandidates();
    if (index > items.length) {
      return;
    }

    this._quickPasteKeysHeld.add(event.get_key_code());
    console.log(this.extension.uuid, 'Quick paste: shortcut pressed', digit);
    this._quickPaste(items[index - 1].entry, !this._keepMenuOpen);
    return true;
  }

  _quickPaste(
    entry,
    closeAfterPaste = false,
    allowClosedMenu = false,
    commitSelection = false,
  ) {
    commitSelection =
      commitSelection && !this._keepMenuOpen && !entry.pasteSetItem;
    if (entry.pasteSetItem && entry.kind === 'command') {
      this._quickPasteCommand(entry, closeAfterPaste, allowClosedMenu);
      return;
    }
    if (entry.type !== DS.TYPE_TEXT || !global.display.focus_window) {
      console.log(
        this.extension.uuid,
        'Quick paste skipped: no text entry or focused application',
      );
      return;
    }
    const target = global.display.focus_window;
    const afterAction =
      !closeAfterPaste && this._keepMenuOpen ? this._pasteAfterAction : 'none';
    const generation = this._clipboardGeneration || 0;
    this._quickPasteBusy = true;
    Clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, original) => {
      if (
        this._destroyed ||
        (!allowClosedMenu && !this.menu.isOpen) ||
        generation !== (this._clipboardGeneration || 0)
      ) {
        this._endQuickPasteTracking();
        return;
      }
      // A new login can have saved history but no current text selection.
      // Treat an absent text clipboard as empty instead of rejecting every paste.
      original ??= '';
      let attempts = 0;
      // Wait for the physical shortcut keys to be released before injecting paste.
      this._quickPasteTimer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        25,
        () => {
          if (this._quickPasteKeysAreHeld()) {
            if (++attempts < 80) return GLib.SOURCE_CONTINUE;
            this._endQuickPasteTracking();
            this._quickPasteTimer = undefined;
            return GLib.SOURCE_REMOVE;
          }
          this._quickPasteTimer = undefined;
          if (
            (!allowClosedMenu && !this.menu.isOpen) ||
            global.display.focus_window !== target ||
            generation !== (this._clipboardGeneration || 0)
          ) {
            this._endQuickPasteTracking();
            return GLib.SOURCE_REMOVE;
          }
          this._quickPasteState = {
            original,
            text: entry.text,
            changed: false,
            keepClipboard: commitSelection && !entry.pasteSetItem,
          };
          if (this.menu.isOpen) this._suspendQuickPasteInput();
          Clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
          if (commitSelection && !entry.pasteSetItem) {
            this._moveEntryFirst(entry);
            this._setCurrentClipboardEntry(entry, false);
          }
          this._sendQuickPasteKeys(closeAfterPaste);
          // Experimental delay: application clipboard reads are asynchronous.
          this._quickPasteTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,
            () => {
              this._quickPasteTimer = undefined;
              const changed = this._quickPasteState?.changed;
              this._finishQuickPaste(true);
              if (
                !changed &&
                !this._destroyed &&
                this.menu.isOpen &&
                global.display.focus_window === target &&
                this._keepMenuOpen &&
                !this._quickPasteKeysAreHeld()
              )
                this._sendPostPasteAction(afterAction);
              return GLib.SOURCE_REMOVE;
            },
          );
          return GLib.SOURCE_REMOVE;
        },
      );
    });
  }

  _cancelPasteCommand() {
    const running = this._pasteCommandRun;
    if (!running) return;
    this._pasteCommandRun = undefined;
    running.cancel();
    this._endQuickPasteTracking();
  }

  _quickPasteCommand(
    entry,
    closeAfterPaste,
    allowClosedMenu,
    copyOnly = false,
  ) {
    if (this._quickPasteBusy || this._destroyed || !global.display.focus_window)
      return;
    const target = global.display.focus_window;
    const generation = this._clipboardGeneration || 0;
    const epoch = this._clipboardQueryEpoch || 0;
    this._quickPasteBusy = true;
    const running = runCommand(entry.command, {
      trimTrailingNewlines: entry.trimTrailingNewlines,
      executionMode: entry.executionMode,
    });
    this._pasteCommandRun = running;
    running.promise
      .then((text) => {
        if (this._pasteCommandRun !== running) return;
        this._pasteCommandRun = undefined;
        this._endQuickPasteTracking();
        if (
          this._destroyed ||
          PRIVATE_MODE ||
          (!allowClosedMenu && !this.menu.isOpen) ||
          global.display.focus_window !== target ||
          generation !== (this._clipboardGeneration || 0) ||
          epoch !== (this._clipboardQueryEpoch || 0)
        )
          return;
        // Pasting is temporary; explicit copy-only actions also enter history.
        const output = { ...entry, kind: 'text', text };
        if (copyOnly) this._copyPasteEntry(output);
        else this._quickPaste(output, closeAfterPaste, allowClosedMenu);
      })
      .catch((error) => {
        if (this._pasteCommandRun !== running) return;
        this._pasteCommandRun = undefined;
        this._endQuickPasteTracking();
        if (!this._destroyed)
          this._showNotification(
            _('Could not execute the command'),
            error.message,
          );
      });
  }

  _sendPostPasteAction(action) {
    const code = action === 'enter' ? 28 : action === 'tab' ? 15 : null;
    if (code === null) return;
    this._quickPasteBusy = true;
    this._suspendQuickPasteInput();
    const keyboard = VirtualKeyboard();
    const time = GLib.get_monotonic_time();
    keyboard.notify_key(time, code, Clutter.KeyState.PRESSED);
    keyboard.notify_key(time, code, Clutter.KeyState.RELEASED);
    this._quickPasteInputTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      40,
      () => {
        this._quickPasteInputTimer = undefined;
        this._endQuickPasteTracking();
        this._resumeQuickPasteInput();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _sendQuickPasteKeys(closeAfterPaste = false) {
    const keyboard = VirtualKeyboard();
    const time = GLib.get_monotonic_time();
    const terminal =
      /terminal|console|kitty|alacritty|wezterm|ghostty|foot|konsole|xterm|tilix|terminator/i.test(
        Shell.WindowTracker.get_default().get_focus_app()?.get_id() || '',
      );
    keyboard.notify_key(time, 29, Clutter.KeyState.PRESSED);
    if (terminal) keyboard.notify_key(time, 42, Clutter.KeyState.PRESSED);
    keyboard.notify_key(time, 47, Clutter.KeyState.PRESSED);
    keyboard.notify_key(time, 47, Clutter.KeyState.RELEASED);
    if (terminal) keyboard.notify_key(time, 42, Clutter.KeyState.RELEASED);
    keyboard.notify_key(time, 29, Clutter.KeyState.RELEASED);
    if (closeAfterPaste) {
      this._quickPasteInputReleased = false;
      this.menu.close();
      return;
    }
    // Clipboard transfer does not need the keyboard grab to remain released.
    this._quickPasteInputTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      40,
      () => {
        this._quickPasteInputTimer = undefined;
        this._resumeQuickPasteInput();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _finishQuickPaste(resume) {
    const state = this._quickPasteState;
    if (!state) return;
    this._quickPasteState = undefined;
    if (!state.changed && !state.keepClipboard) {
      this._quickPasteRestoring = true;
      Clipboard.set_text(St.ClipboardType.CLIPBOARD, state.original);
      this._quickPasteRestoring = false;
    }
    this._endQuickPasteTracking();
    if (resume) this._resumeQuickPasteInput();
  }

  _endQuickPasteTracking() {
    this._quickPasteBusy = false;
    if (this._pendingClipboardCopy) {
      this._pendingClipboardCopy = false;
      if (!this._destroyed) this._queryClipboard(true);
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

  _addEntry(entry, selectEntry, updateClipboard, insertIndex) {
    if (this.activeHistoryMenuItems >= PAGE_SIZE) {
      const items = this.historySection._getMenuItems();
      const item = items[items.length - 1];
      this._rewriteMenuItem(item, entry);
      this.historySection.moveMenuItem(item, 0);
      this._updateCandidateNumbers();

      if (selectEntry) {
        this._setCurrentClipboardEntry(entry, updateClipboard);
      }
      return;
    }

    const menuItem = new PopupMenu.PopupMenuItem('', { hover: false });
    menuItem.add_style_class_name('ci-clipboard-row');
    menuItem.label.x_expand = true;
    this._hideCandidateOrnament(menuItem);

    menuItem.entry = entry;
    this._makePasteItemDraggable(menuItem);
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

    menuItem.connect('activate', this._activateHistoryRow.bind(this));

    this._setEntryLabel(menuItem);

    // Add this history text to a paste set without changing the clipboard.
    const iconfav = new St.Icon({
      icon_name: 'list-add-symbolic',
      style_class: 'system-status-icon',
    });

    const icofavBtn = new St.Button({
      style_class: 'ci-action-btn',
      can_focus: true,
      accessible_name: _('Add to a paste set'),
      child: iconfav,
      x_align: Clutter.ActorAlign.END,
      x_expand: false,
      y_expand: true,
    });

    menuItem.actor.add_child(icofavBtn);
    icofavBtn.connect('clicked', () => {
      this._addToPasteSet(menuItem.entry.text);
    });

    // Delete button
    const icon = new St.Icon({
      icon_name: 'edit-delete-symbolic',
      style_class: 'system-status-icon',
    });

    const icoBtn = new St.Button({
      style_class: 'ci-action-btn',
      can_focus: true,
      accessible_name: _('Delete from history'),
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
      if (menuItem.entry.menuItem === menuItem) delete menuItem.entry.menuItem;
      this.activeHistoryMenuItems--;
    });
    menuItem.connect('key-focus-in', () => {
      ensureActorVisibleInScrollView(this.historyScrollView, menuItem);
    });

    this.historySection.addMenuItem(menuItem, insertIndex);
    this.activeHistoryMenuItems++;

    this._updateCandidateNumbers();
    if (selectEntry) {
      this._setCurrentClipboardEntry(entry, updateClipboard);
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

  _hideCandidateOrnament(item) {
    item.setOrnament(PopupMenu.Ornament.NONE);
    item._ornamentIcon.hide();
  }

  _setCandidateAccessibleName(item) {
    const shortcut = item.shortcutLabel?.get_text();
    const description =
      item.entry.kind === 'command'
        ? format(_('Command: %s'), item.label.get_text())
        : item.label.get_text();
    item.accessible_name = shortcut
      ? `${item.shortcutLabel.shortcutName || shortcut}. ${description}`
      : description;
  }

  _updateCandidateNumbers() {
    if (this._destroyed) return;
    for (const [section, modifiers] of [
      [this.historySection, this._historyPasteModifiers],
      [this._pasteSetSection, this._historyPasteModifiers],
    ]) {
      if (!section) continue;
      const items = section._getMenuItems();
      items.forEach((item, index) => {
        if (!item.shortcutLabel) return;
        item.shortcutLabel.shortcutName =
          index < 9 ? `${modifierLabel(modifiers)}+${index + 1}` : '';
        item.shortcutLabel.set_text(index < 9 ? String(index + 1) : '');
        this._setCandidateAccessibleName(item);
      });
    }
  }

  _setEntryLabel(menuItem) {
    const entry = menuItem.entry;
    if (entry.type === DS.TYPE_TEXT) {
      menuItem.label.set_text(this._truncated(entry.text, MAX_VISIBLE_CHARS));
    } else {
      throw new TypeError('Unknown type: ' + entry.type);
    }
  }

  _removeAll() {
    this._confirmRemoveAll();
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
        if (!this._destroyed) this._clearHistory();
      },
    );
  }

  _clearHistory() {
    this._clearCurrentClipboardEntry(true);
    this._lastPrimaryEntry = undefined;

    // Paste sets and archived history records are independent of ordinary history.
    this.entries = new DS.LinkedList();
    this.historySection.removeAll();
    this.activeHistoryMenuItems = 0;

    Store.resetDatabase(this._currentStateBuilder.bind(this));
  }

  _removeEntry(entry, fullyDelete, humanGenerated) {
    if (fullyDelete) {
      entry.detach();

      if (entry.diskId) {
        Store.deleteTextEntry(entry.diskId);
      }
    }

    if (entry.id === this._currentClipboardEntry?.id) {
      this._clearCurrentClipboardEntry(humanGenerated);
    }
    entry.menuItem?.destroy();
    this._updateCandidateNumbers();
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

  _setCurrentClipboardEntry(entry, updateClipboard) {
    // Tracks the actual clipboard, independently of keyboard focus.
    this._currentClipboardEntry = entry;

    this._updateButtonText(entry);
    if (updateClipboard !== false) {
      if (entry.type === DS.TYPE_TEXT) {
        this._setClipboardText(entry.text);
      } else {
        throw new TypeError('Unknown type: ' + entry.type);
      }
    }
  }

  _setClipboardText(text) {
    this._quickPasteRestoring = true;
    try {
      Clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
      Clipboard.set_text(St.ClipboardType.PRIMARY, text);
    } finally {
      this._quickPasteRestoring = false;
    }
  }

  _activateHistoryRow(menuItem) {
    if (this._draggingPasteItem) {
      GObject.signal_stop_emission_by_name(menuItem, 'activate');
      return;
    }
    // PopupMenu's default activation would close before Clipboard.get_text
    // completes, aborting unpinned pastes (and cancelling command execution).
    GObject.signal_stop_emission_by_name(menuItem, 'activate');
    this._activatePasteEntry(menuItem.entry);
  }

  _activatePasteEntry(entry) {
    if (this._quickPasteBusy) return;
    if (PASTE_ON_SELECTION) {
      this._quickPaste(
        entry,
        !this._keepMenuOpen,
        false,
        !entry.pasteSetItem && !this._keepMenuOpen,
      );
      return;
    }
    if (entry.pasteSetItem && entry.kind === 'command')
      this._quickPasteCommand(entry, !this._keepMenuOpen, false, true);
    else this._copyPasteEntry(entry);
  }

  _copyPasteEntry(entry) {
    // Copy-only is an explicit clipboard change, including sets and command output.
    const text = STRIP_TEXT ? entry.text.trim() : entry.text;
    this._quickPasteRestoring = true;
    try {
      Clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    } finally {
      this._quickPasteRestoring = false;
    }
    this._processClipboardContent(text, true, true);
    if (!this._keepMenuOpen) this.menu.close();
  }

  _clearCurrentClipboardEntry(resetClipboard) {
    this._currentClipboardEntry = undefined;
    this._updateButtonText();
    if (resetClipboard) {
      this._setClipboardText('');
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
      this._addEntry(entry, this._currentClipboardEntry === entry, false);
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
    if (item.entry.menuItem === item) delete item.entry.menuItem;
    item.entry = entry;
    entry.menuItem = item;

    this._setEntryLabel(item);
  }

  _onSearchTextChanged() {
    if (this._pasteSets && this._activePasteTab !== 'history') {
      this._renderPasteSets();
      return;
    }
    const query = this.searchEntry.get_text();

    if (!query) {
      this.historySection.removeAll();

      this.searchEntryFront = this.searchEntryBack = undefined;
      this._maybeRestoreMenuPages();
      return;
    }

    this.searchEntryFront = this.searchEntryBack = this.entries.last();
    this.populateSearchResults(query);
  }

  populateSearchResults(query, forward) {
    this.historySection.removeAll();

    if (typeof forward !== 'boolean') {
      forward = true;
    }

    query = query.toLowerCase();
    let searchExp;
    try {
      searchExp = new RegExp(query, 'i');
    } catch {}
    if (!this.searchEntryFront) return;
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
            entry === this._currentClipboardEntry,
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

  _queryClipboard(externalCopy = false, restoreEmpty = false) {
    if (this._destroyed || !this.entries || PRIVATE_MODE) {
      return;
    }

    const generation = this._clipboardGeneration || 0;
    const epoch = this._clipboardQueryEpoch || 0;
    Clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
      if (
        this._destroyed ||
        PRIVATE_MODE ||
        epoch !== (this._clipboardQueryEpoch || 0) ||
        generation !== (this._clipboardGeneration || 0)
      )
        return;
      if (!text && restoreEmpty && this.entries.last()) {
        const mimetypes =
          this.selection.get_mimetypes(
            Meta.SelectionType.SELECTION_CLIPBOARD,
          ) || [];
        // Restore only an empty/text-only clipboard, never images or other data.
        const textOnly = mimetypes.every((type) =>
          /^(text\/plain(?:;.*)?|UTF8_STRING|STRING|TEXT|COMPOUND_TEXT)$/i.test(
            type,
          ),
        );
        if (textOnly) {
          this._setCurrentClipboardEntry(this.entries.last(), true);
          return;
        }
      }
      this._processClipboardContent(text, true, externalCopy);
    });
  }

  _queryPrimaryClipboard() {
    if (
      this._destroyed ||
      !this.entries ||
      !PROCESS_PRIMARY_SELECTION ||
      PRIVATE_MODE
    ) {
      return;
    }

    const epoch = this._clipboardQueryEpoch || 0;
    const generation = (this._primaryQueryGeneration =
      (this._primaryQueryGeneration || 0) + 1);
    Clipboard.get_text(St.ClipboardType.PRIMARY, (_, text) => {
      if (
        this._destroyed ||
        PRIVATE_MODE ||
        !PROCESS_PRIMARY_SELECTION ||
        epoch !== (this._clipboardQueryEpoch || 0) ||
        generation !== this._primaryQueryGeneration
      )
        return;
      const last = this._lastPrimaryEntry;
      text = this._processClipboardContent(text, false);
      this._lastPrimaryEntry = text
        ? this.entries.findTextItem(text)
        : undefined;
      if (
        last &&
        last.list === this.entries &&
        last !== this._currentClipboardEntry &&
        last !== this._lastPrimaryEntry &&
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
    if (this._loggingOut || this._destroyed) return;
    if (this._quickPasteBusy || this._quickPasteRestoring) {
      if (externalCopy) this._pendingClipboardCopy = true;
      return;
    }
    if (STRIP_TEXT && text) {
      const trimmed = text.trim();
      if (selectEntry && trimmed !== text) {
        this._quickPasteRestoring = true;
        try {
          Clipboard.set_text(St.ClipboardType.CLIPBOARD, trimmed);
        } finally {
          this._quickPasteRestoring = false;
        }
      }
      text = trimmed;
    }
    if (!text) {
      if (selectEntry) this._clearCurrentClipboardEntry(false);
      return;
    }
    const current = this._currentClipboardEntry;

    let entry = this.entries.findTextItem(text);
    if (entry) {
      const isFirst = entry === this.entries.last();
      if (!isFirst) {
        this._moveEntryFirst(entry);
      }
      if (selectEntry && (!isFirst || entry !== this._currentClipboardEntry)) {
        this._setCurrentClipboardEntry(entry, false);
      }
    } else {
      entry = new DS.LLNode();
      entry.id = this.nextId++;
      entry.diskId = this.nextDiskId++;
      entry.type = DS.TYPE_TEXT;
      entry.text = text;
      this.entries.append(entry);
      this._addEntry(entry, selectEntry, false, 0);

      Store.storeTextEntry(text);
    }

    // PRIMARY selections are saved immediately below the current clipboard.
    // Moving both entries also persists their order in the existing history log.
    if (
      !selectEntry &&
      current &&
      current !== entry &&
      current.list === this.entries
    )
      this._moveEntryFirst(current);
    this._pruneOldestEntries();

    if (COPY_FEEDBACK !== 0) {
      this._highlightCopy();
    }

    return text;
  }

  _clearCopyHighlight() {
    if (this._copyPanelFlashTimer) {
      GLib.Source.remove(this._copyPanelFlashTimer);
      this._copyPanelFlashTimer = undefined;
    }
    if (this._copyHighlightTimer) {
      GLib.Source.remove(this._copyHighlightTimer);
      this._copyHighlightTimer = undefined;
    }
    this.icon.remove_style_class_name('copy-highlight');
    if (this._copyBubble) {
      this._copyBubble.destroy();
      this._copyBubble = undefined;
    }
    this._copyPanelFlash?.destroy();
    this._copyPanelFlash = undefined;
  }

  _highlightCopy() {
    if (
      this._destroyed ||
      PRIVATE_MODE ||
      this._quickPasteBusy ||
      this._quickPasteRestoring
    )
      return;
    this._clearCopyHighlight();
    const mode = COPY_FEEDBACK;
    if (mode === 0) return;
    if (mode === 4) {
      this._showNotification(_('Copied'), '');
      return;
    }
    if (mode === 1 || mode === 2)
      this.icon.add_style_class_name('copy-highlight');
    if (mode === 3 || mode === 5) {
      const [x, y] = Main.panel.get_transformed_position();
      const [width, height] = Main.panel.get_transformed_size();
      this._copyPanelFlash = new St.Widget({
        style_class: 'ci-copy-panel-flash',
        reactive: false,
        can_focus: false,
        width,
        height,
        x,
        y,
      });
      Main.uiGroup.add_child(this._copyPanelFlash);
      if (St.Settings.get().enable_animations)
        this._copyPanelFlash.ease({
          opacity: 0,
          duration: 350,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      if (mode === 5) {
        this._copyPanelFlashTimer = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          350,
          () => {
            this._copyPanelFlashTimer = undefined;
            this._copyPanelFlash?.destroy();
            this._copyPanelFlash = undefined;
            return GLib.SOURCE_REMOVE;
          },
        );
      }
    }
    const anchor =
      this.icon.visible && this.icon.mapped ? this.icon : Main.panel;
    const monitor = Main.layoutManager.findMonitorForActor(anchor);
    if ((mode === 2 || mode === 5) && monitor && anchor.mapped) {
      this._copyBubble = new St.Label({
        text: _('Copied!'),
        style_class: 'ci-copy-bubble',
        reactive: false,
        can_focus: false,
      });
      Main.uiGroup.add_child(this._copyBubble);
      const [, width] = this._copyBubble.get_preferred_width(-1);
      const [, height] = this._copyBubble.get_preferred_height(width);
      const [iconX, iconY] = anchor.get_transformed_position();
      const [iconWidth, iconHeight] = anchor.get_transformed_size();
      const margin = 6;
      const x = Math.max(
        monitor.x + margin,
        Math.min(
          iconX + iconWidth / 2 - width / 2,
          monitor.x + monitor.width - width - margin,
        ),
      );
      const y = Math.max(
        monitor.y + margin,
        Math.min(
          iconY + iconHeight + 14,
          monitor.y + monitor.height - height - margin,
        ),
      );
      this._copyBubble.set_position(Math.round(x), Math.round(y));
      this._copyBubble.set_size(width, height);
    }
    this._copyHighlightTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      mode === 3 ? 350 : 800,
      () => {
        this._copyHighlightTimer = undefined;
        this._clearCopyHighlight();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _moveEntryFirst(entry) {
    if (entry.menuItem) {
      this.historySection.moveMenuItem(entry.menuItem, 0);
      this._updateCandidateNumbers();
    } else {
      this._addEntry(entry, false, false, 0);
    }

    this.entries.append(entry);
    if (entry.diskId) {
      Store.moveEntryToEnd(entry.diskId);
    }
  }

  _currentStateBuilder() {
    const state = [];

    this.nextDiskId = 1;
    // Preserve archived log records without exposing a second history UI.
    for (const entry of this._archivedHistoryEntries) {
      entry.diskId = this.nextDiskId++;
      state.push(entry);
    }
    for (const entry of this.entries) {
      entry.diskId = this.nextDiskId++;
      state.push(entry);
    }

    return state;
  }

  _setupSelectionChangeListener() {
    this.selection = Shell.Global.get().get_display().get_selection();
    this._selectionOwnerChangedId = this.selection.connect(
      'owner-changed',
      (_, selectionType) => {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
          this._clipboardGeneration = (this._clipboardGeneration || 0) + 1;
          if (this._quickPasteRestoring) return;
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
          !this._quickPasteRestoring &&
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

    if (!this._currentClipboardEntry) {
      const nextEntry = this.entries.last();
      if (nextEntry) {
        this._setCurrentClipboardEntry(nextEntry, true);
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
    // Invalidate reads started before a privacy transition.
    this._clipboardQueryEpoch = (this._clipboardQueryEpoch || 0) + 1;
    // We hide the history in private mode because it will be out of sync
    // (selected item will not reflect clipboard)
    this.scrollViewMenuSection.actor.visible = !PRIVATE_MODE;
    this._applyPasteSetVisibility();

    if (PRIVATE_MODE) {
      this._clearCurrentClipboardEntry(false);
      this.icon.add_style_class_name('private-mode');
      this._updateButtonText();
    } else {
      this.icon.remove_style_class_name('private-mode');
      if (this._currentClipboardEntry) {
        this._setCurrentClipboardEntry(this._currentClipboardEntry, false);
      } else {
        this._clearCurrentClipboardEntry(false);
      }
      this._queryClipboard(true);
    }
  }

  _fetchSettings() {
    this._keepMenuOpen = this.settings.get_boolean(
      SettingsFields.KEEP_MENU_OPEN,
    );
    this._historyPasteModifiers = this.settings.get_int(
      SettingsFields.QUICK_PASTE_MODIFIERS,
    );
    MAX_REGISTRY_LENGTH = this.settings.get_int(SettingsFields.HISTORY_SIZE);
    MAX_BYTES =
      (1 << 20) * this.settings.get_int(SettingsFields.CACHE_FILE_SIZE);
    WINDOW_WIDTH_PERCENTAGE = this.settings.get_int(
      SettingsFields.WINDOW_WIDTH_PERCENTAGE,
    );
    COPY_FEEDBACK = this.settings.get_int(SettingsFields.COPY_FEEDBACK);
    CLEAR_ON_LOGOUT = this.settings.get_boolean(SettingsFields.CLEAR_ON_LOGOUT);
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
  }

  _onSettingsChange() {
    const prevPrivateMode = PRIVATE_MODE;
    const prevClearOnLogout = CLEAR_ON_LOGOUT;

    this._fetchSettings();
    if (prevClearOnLogout !== CLEAR_ON_LOGOUT) {
      try {
        this._historySession?.setEnabled(CLEAR_ON_LOGOUT);
      } catch (error) {
        this._showNotification(
          _('Could not save session metadata'),
          error.message,
        );
      }
    }
    this._updateCandidateNumbers();
    this._syncModeButtons();
    if (COPY_FEEDBACK === 0 || PRIVATE_MODE) this._clearCopyHighlight();

    if (prevPrivateMode !== undefined && PRIVATE_MODE !== prevPrivateMode) {
      this._updatePrivateModeState();
    }

    // Remove old entries in case the registry size changed
    this._pruneOldestEntries();

    // Re-set menu-items labels in case preview size changed
    const resetLabel = (item) => this._setEntryLabel(item);
    this.historySection._getMenuItems().forEach(resetLabel);

    this._updateTopbarLayout();
    if (this._currentClipboardEntry) {
      this._updateButtonText(this._currentClipboardEntry);
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
    this._bindShortcut(SETTING_KEY_TOGGLE_MENU, () => this.menu.toggle());
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

export default class PasteBoardExtension extends Extension {
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
