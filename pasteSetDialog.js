import { _, format } from './i18n.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Atk from 'gi://Atk';
import Pango from 'gi://Pango';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { runCommand } from './commandOutput.js';
import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// ScrollView allocates its child's minimum height. A multiline entry must not
// report a single line as its minimum, otherwise the remaining lines are clipped.
const MultilineEntry = GObject.registerClass(
  class MultilineEntry extends St.Entry {
    vfunc_get_preferred_height(width) {
      const [, height] = super.vfunc_get_preferred_height(width);
      return [height, height];
    }
  },
);

export const PasteSetDialog = GObject.registerClass(
  class PasteSetDialog extends ModalDialog.ModalDialog {
    _init(title, name, text, save, remove = null, options = {}) {
      super._init();
      this.connect('destroy', () => {
        this._editorPreviewDestroyed = true;
        const running = this._editorPreviewRun;
        this._editorPreviewRun = null;
        running?.cancel();
      });
      const titleLabel = new St.Label({
        text: title,
        style_class: 'ci-editor-title',
        accessible_role: Atk.Role.HEADING,
      });
      this.contentLayout.add_child(titleLabel);
      const nameLabel = new St.Label({ text: _('Name') });
      this.contentLayout.add_child(nameLabel);
      const nameInput = new St.Entry({
        text: name,
        can_focus: true,
        accessible_name: _('Name'),
        label_actor: nameLabel,
        style_class: 'ci-editor-name',
      });
      nameInput.clutter_text.set_max_length(text === null ? 100 : 200);
      this.contentLayout.add_child(nameInput);
      let body;
      let syncEditor;
      let kind = options.kind || 'text';
      let executionMode = options.executionMode || 'direct';
      let previewOnOpen = options.previewOnOpen === true;
      let trimTrailingNewlines = options.trimTrailingNewlines !== false;
      if (text !== null) {
        const types = new St.BoxLayout({
          style_class: 'ci-editor-tabs',
          accessible_role: Atk.Role.PAGE_TAB_LIST,
          accessible_name: _('Item type'),
        });
        this.contentLayout.add_child(types);
        const bodyLabel = new St.Label({ text: '' });
        this.contentLayout.add_child(bodyLabel);
        const scroll = new St.ScrollView({ style_class: 'ci-set-body-scroll' });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        body = new MultilineEntry({
          text,
          can_focus: true,
          accessible_name: _('Text to paste'),
          style_class: 'ci-set-body',
        });
        body.clutter_text.y_align = Clutter.ActorAlign.START;
        body.clutter_text.single_line_mode = false;
        body.clutter_text.activatable = false;
        body.clutter_text.line_wrap = true;
        body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        // St.Entry only focuses its text actor when the text itself is hit.
        // The multiline entry also has empty space below short content.
        body.connect('button-press-event', (_, event) => {
          if (event.get_button() === Clutter.BUTTON_PRIMARY)
            body.grab_key_focus();
          return Clutter.EVENT_PROPAGATE;
        });
        const bodyBox = new St.BoxLayout({});
        bodyBox.add_child(body);
        scroll.add_child(bodyBox);
        body.clutter_text.connect('cursor-changed', () => {
          const [valid, , y, height] = body.clutter_text.position_to_coords(
            body.clutter_text.cursor_position,
          );
          if (!valid) return;
          const adjustment = scroll.vadjustment;
          const top = body.clutter_text.y + y;
          const bottom = top + height;
          if (top < adjustment.value) adjustment.value = top;
          else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
        });
        this.contentLayout.add_child(scroll);
        const modes = new St.BoxLayout({
          style_class: 'ci-editor-mode-row',
          accessible_name: _('Execution mode'),
        });
        this.contentLayout.add_child(modes);
        const explanation = new St.Label({
          style_class: 'ci-set-error',
          text: '',
          can_focus: true,
          reactive: true,
        });
        explanation.clutter_text.line_wrap = true;
        explanation.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        explanation.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.contentLayout.add_child(explanation);
        const trim = new CheckBox.CheckBox(_('Trim trailing newlines'));
        this.contentLayout.add_child(trim);
        const preview = new CheckBox.CheckBox(
          _('Preview output when opening this tab'),
        );
        this.contentLayout.add_child(preview);
        const controls = new St.BoxLayout({
          style_class: 'ci-editor-run-row',
        });
        this._editorRun = new St.Button({
          label: _('Run and preview'),
          can_focus: true,
          style_class: 'ci-paste-action-choice',
        });
        this._editorStop = new St.Button({
          label: _('Stop'),
          can_focus: true,
          style_class: 'ci-paste-action-choice',
          visible: false,
        });
        controls.add_child(this._editorRun);
        controls.add_child(this._editorStop);
        const help = new St.Button({
          label: '?',
          can_focus: true,
          toggle_mode: true,
          accessible_role: Atk.Role.TOGGLE_BUTTON,
          accessible_name: _('About command execution'),
          style_class: 'ci-editor-help',
          x_align: Clutter.ActorAlign.END,
          x_expand: true,
        });
        help
          .get_accessible()
          .set_description(_('Show or hide command execution details.'));
        help
          .get_accessible()
          .add_relationship(
            Atk.RelationType.CONTROLLER_FOR,
            explanation.get_accessible(),
          );
        explanation
          .get_accessible()
          .add_relationship(
            Atk.RelationType.CONTROLLED_BY,
            help.get_accessible(),
          );
        controls.add_child(help);
        help.connect('clicked', () => {
          explanation.visible = help.checked;
          if (help.checked) help.add_accessible_state(Atk.StateType.EXPANDED);
          else help.remove_accessible_state(Atk.StateType.EXPANDED);
        });
        const warning = new St.Label({
          text: _('Runs with your user permissions.'),
          style_class: 'ci-editor-warning',
        });
        warning.clutter_text.line_wrap = true;
        warning.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.contentLayout.add_child(controls);
        this.contentLayout.add_child(warning);
        this._editorStatus = new St.Label({
          text: _('Output'),
          style_class: 'ci-set-error',
        });
        this._editorStatus.clutter_text.line_wrap = true;
        this._editorStatus.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.contentLayout.add_child(this._editorStatus);
        const outputScroll = new St.ScrollView({
          style_class: 'ci-editor-output-scroll',
        });
        outputScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._editorOutput = new MultilineEntry({
          can_focus: true,
          accessible_name: _('Command output'),
          hint_text: _('Command output'),
          style_class: 'ci-editor-output',
        });
        Object.assign(this._editorOutput.clutter_text, {
          single_line_mode: false,
          activatable: false,
          editable: false,
          selectable: true,
          line_wrap: true,
          line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        });
        const outputBox = new St.BoxLayout({});
        outputBox.add_child(this._editorOutput);
        outputScroll.add_child(outputBox);
        this.contentLayout.add_child(outputScroll);
        this._editorRun.connect('clicked', () => {
          if (kind !== 'command') return;
          if (options.canPreview && !options.canPreview()) {
            this._cancelCommandPreview();
            this._editorStatus.text = _('Preview unavailable');
            return;
          }
          this._startCommandPreview(body.get_text(), {
            executionMode,
            trimTrailingNewlines,
          });
          if (this._editorPreviewRun) this._editorStop.grab_key_focus();
          if (this._editorScroll)
            ensureActorVisibleInScrollView(this._editorScroll, outputScroll);
        });
        this._editorStop.connect('clicked', () => {
          this._cancelCommandPreview();
          this._editorStatus.text = _('Preview stopped');
        });
        body.clutter_text.connect('text-changed', () =>
          this._cancelCommandPreview(),
        );
        const typeButtons = [];
        modes.add_child(
          new St.Label({
            text: _('Execution mode'),
            y_align: Clutter.ActorAlign.CENTER,
          }),
        );
        const modeSelect = new St.Button({
          can_focus: true,
          accessible_role: Atk.Role.COMBO_BOX,
          style_class: 'ci-editor-select',
        });
        const modeContent = new St.BoxLayout({
          style_class: 'ci-editor-select-content',
        });
        const modeLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        modeContent.add_child(modeLabel);
        modeContent.add_child(
          new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12 }),
        );
        modeSelect.set_child(modeContent);
        modes.add_child(modeSelect);
        const modeMenu = new PopupMenu.PopupMenu(modeSelect, 0, St.Side.TOP);
        this._editorModeMenu = modeMenu;
        Main.uiGroup.add_child(modeMenu.actor);
        modeMenu.actor.hide();
        const modeManager = new PopupMenu.PopupMenuManager(this);
        modeManager.addMenu(modeMenu);
        modeSelect.connect('clicked', () => modeMenu.toggle());
        modeMenu.connect('open-state-changed', (_, open) => {
          if (open) modeSelect.add_accessible_state(Atk.StateType.EXPANDED);
          else modeSelect.remove_accessible_state(Atk.StateType.EXPANDED);
        });
        this.connect('destroy', () => {
          modeMenu.destroy();
          this._editorModeMenu = null;
        });
        const modeItems = [];
        const sync = () => {
          this._cancelCommandPreview();
          const command = kind === 'command';
          bodyLabel.set_text(command ? _('Command') : _('Body'));
          body.accessible_name = command
            ? _('Command to execute')
            : _('Text to paste');
          body.hint_text = command ? "date '+%Y-%m-%d %H:%M:%S'" : '';
          explanation.visible = command && help.checked;
          warning.visible =
            trim.visible =
            modes.visible =
            preview.visible =
              command;
          controls.visible =
            this._editorStatus.visible =
            outputScroll.visible =
              command;
          explanation.set_text(
            [
              previewOnOpen
                ? _(
                    'Opening this tab runs the command. Pasting uses the previewed output.',
                  )
                : executionMode === 'bash'
                  ? _(
                      'Runs in Bash when pasted. Pipes and variable expansion are supported.',
                    )
                  : _(
                      'Runs directly when pasted. Pipes and variable expansion are not performed.',
                    ),
              _(
                'Runs with your permissions and can modify or delete files or access the network. Commands execute even without output. Register only commands you understand and trust.',
              ),
              _(
                'Commands requiring interactive input, such as password prompts, are not supported.',
              ),
              _(
                'Limits: 3 seconds and 64 KiB of output. Actions already performed cannot be undone.',
              ),
            ].join('\n'),
          );
          preview.checked = previewOnOpen;
          trim.checked = trimTrailingNewlines;
          const selectedMode =
            executionMode === 'bash'
              ? _('Bash (one-liner)')
              : _('Direct execution');
          modeLabel.text = selectedMode;
          modeSelect.accessible_name = format(
            _('Execution mode: %s'),
            selectedMode,
          );
          for (const [value, item] of modeItems)
            item.setOrnament(
              value === executionMode
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE,
            );
          for (const [value, button] of typeButtons) {
            if (kind === value) {
              button.add_style_pseudo_class('checked');
              button.add_accessible_state(Atk.StateType.SELECTED);
            } else {
              button.remove_style_pseudo_class('checked');
              button.remove_accessible_state(Atk.StateType.SELECTED);
            }
          }
        };
        for (const [value, label] of [
          ['text', _('Text')],
          ['command', _('Command')],
        ]) {
          const button = new St.Button({
            accessible_name: label,
            can_focus: true,
            accessible_role: Atk.Role.PAGE_TAB,
            style_class: 'ci-paste-tab',
          });
          const tabContent = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
          });
          tabContent.add_child(new St.Label({ text: label }));
          tabContent.add_child(
            new St.Widget({ style_class: 'ci-tab-underline' }),
          );
          button.set_child(tabContent);
          button.connect('key-press-event', (_, event) => {
            const symbol = event.get_key_symbol();
            if (symbol !== Clutter.KEY_Left && symbol !== Clutter.KEY_Right)
              return Clutter.EVENT_PROPAGATE;
            const next = typeButtons.find(([type]) => type !== kind);
            kind = next[0];
            sync();
            next[1].grab_key_focus();
            return Clutter.EVENT_STOP;
          });
          button.connect('clicked', () => {
            kind = value;
            sync();
          });
          typeButtons.push([value, button]);
          types.add_child(button);
        }
        for (const [value, label] of [
          ['direct', _('Direct execution')],
          ['bash', _('Bash (one-liner)')],
        ]) {
          const item = new PopupMenu.PopupMenuItem(label);
          item.connect('activate', () => {
            executionMode = value;
            sync();
          });
          modeItems.push([value, item]);
          modeMenu.addMenuItem(item);
        }
        preview.connect('clicked', () => {
          previewOnOpen = preview.checked;
          sync();
        });
        trim.connect('clicked', () => {
          trimTrailingNewlines = trim.checked;
          sync();
        });
        // Keep the trial-and-error workflow together: input, execute, output.
        for (const actor of [
          types,
          modes,
          bodyLabel,
          scroll,
          controls,
          warning,
          explanation,
          this._editorStatus,
          outputScroll,
          trim,
          preview,
        ]) {
          this.contentLayout.remove_child(actor);
          this.contentLayout.add_child(actor);
        }
        syncEditor = sync;
      }
      const error = new St.Label({ text: '', style_class: 'ci-set-error' });
      error.clutter_text.line_wrap = true;
      this.contentLayout.add_child(error);
      const commit = () => {
        this._cancelCommandPreview();
        try {
          save(nameInput.get_text().trim(), body?.get_text(), {
            kind,
            trimTrailingNewlines,
            executionMode,
            previewOnOpen,
          });
          this.close();
        } catch (e) {
          error.set_text(e.message);
          if (this._editorScroll)
            ensureActorVisibleInScrollView(this._editorScroll, error);
        }
      };
      if (!body) nameInput.clutter_text.connect('activate', commit);
      const buttons = [
        {
          label: _('Cancel'),
          key: Clutter.KEY_Escape,
          action: () => this.close(),
        },
        { label: _('Save'), action: commit },
      ];
      if (remove)
        buttons.unshift({
          label: _('Delete tab'),
          action: () => {
            this.connect('closed', remove);
            this.close();
          },
        });
      if (body) {
        const contents = new St.BoxLayout({
          x_expand: true,
          style_class: 'ci-editor-fields',
        });
        contents.set_vertical(true);
        for (const child of this.contentLayout.get_children()) {
          if (child === titleLabel) continue;
          this.contentLayout.remove_child(child);
          contents.add_child(child);
        }
        const editorScroll = new St.ScrollView({ overlay_scrollbars: true });
        this._editorScroll = editorScroll;
        const monitor =
          Main.layoutManager.currentMonitor ||
          Main.layoutManager.primaryMonitor;
        editorScroll.set_style(
          `max-height: ${Math.max(120, (monitor?.height || 768) - 240)}px;`,
        );
        editorScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        editorScroll.add_child(contents);
        this.contentLayout.add_child(editorScroll);
        global.stage.connectObject(
          'notify::key-focus',
          () => {
            const focus = global.stage.get_key_focus();
            if (focus && editorScroll.contains(focus)) {
              let visibleActor = focus;
              for (
                let parent = focus.get_parent();
                parent && parent !== editorScroll;
                parent = parent.get_parent()
              )
                if (parent instanceof St.ScrollView) visibleActor = parent;
              ensureActorVisibleInScrollView(editorScroll, visibleActor);
            }
          },
          this,
        );
      }
      // Reparenting actors into the scroll view shows them again. Apply the
      // selected type only after the editor's widget hierarchy is complete.
      syncEditor?.();
      this.setButtons(buttons);
      this.setInitialKeyFocus(nameInput);
    }

    _setCommandPreviewState(text, status, running = false) {
      if (this._editorPreviewDestroyed || !this._editorOutput) return;
      this._editorOutput.set_text(text);
      this._editorStatus.text = status;
      const stopFocused = this._editorStop.has_key_focus?.();
      this._editorRun.reactive = this._editorRun.can_focus = !running;
      this._editorStop.visible = running;
      if (!running && stopFocused && !this._editorPreviewClosed)
        this._editorRun.grab_key_focus?.();
    }

    _cancelCommandPreview() {
      const running = this._editorPreviewRun;
      this._editorPreviewRun = null;
      running?.cancel();
      this._setCommandPreviewState('', _('Output'));
    }

    _startCommandPreview(command, options) {
      if (this._editorPreviewDestroyed || this._editorPreviewClosed) return;
      this._cancelCommandPreview();
      const running = runCommand(command, options);
      this._editorPreviewRun = running;
      this._setCommandPreviewState('', _('Running command…'), true);
      running.promise.then(
        (text) => {
          if (this._editorPreviewRun !== running) return;
          this._editorPreviewRun = null;
          this._setCommandPreviewState(text, _('Output'));
        },
        (error) => {
          if (this._editorPreviewRun !== running) return;
          this._editorPreviewRun = null;
          this._setCommandPreviewState(
            error.message,
            _('Could not execute the command'),
          );
        },
      );
    }

    close() {
      this._editorPreviewClosed = true;
      this._editorModeMenu?.close();
      this._cancelCommandPreview();
      super.close();
    }
  },
);

export const PasteSetTargetDialog = GObject.registerClass(
  class PasteSetTargetDialog extends ModalDialog.ModalDialog {
    _init(sets, choose) {
      super._init();
      this.contentLayout.add_child(
        new St.Label({ text: _('Choose a paste set') }),
      );
      const scroll = new St.ScrollView({ style_class: 'ci-set-targets' });
      const list = new St.BoxLayout({});
      list.set_vertical(true);
      scroll.add_child(list);
      this.contentLayout.add_child(scroll);
      const error = new St.Label({ text: '' });
      this.contentLayout.add_child(error);
      for (const set of sets) {
        const button = new St.Button({
          label: set.name,
          can_focus: true,
          style_class: 'ci-paste-action-choice',
        });
        button.connect('clicked', () => {
          try {
            choose(set.id);
            this.close();
          } catch (e) {
            error.set_text(e.message);
          }
        });
        list.add_child(button);
      }
      this.setButtons([
        {
          label: _('Cancel'),
          key: Clutter.KEY_Escape,
          action: () => this.close(),
        },
      ]);
      this.setInitialKeyFocus(list.get_first_child());
    }
  },
);
