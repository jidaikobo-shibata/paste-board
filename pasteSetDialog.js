import { _, format } from './i18n.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Atk from 'gi://Atk';
import Pango from 'gi://Pango';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { runCommand } from './commandOutput.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

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
      this.contentLayout.add_child(new St.Label({ text: title }));
      const nameInput = new St.Entry({
        text: name,
        can_focus: true,
        accessible_name: _('Name'),
        hint_text: _('Name'),
      });
      nameInput.clutter_text.set_max_length(text === null ? 100 : 200);
      this.contentLayout.add_child(nameInput);
      let body;
      let kind = options.kind || 'text';
      let executionMode = options.executionMode || 'direct';
      let previewOnOpen = options.previewOnOpen === true;
      let trimTrailingNewlines = options.trimTrailingNewlines !== false;
      if (text !== null) {
        const types = new St.BoxLayout({ style_class: 'ci-paste-action-row' });
        this.contentLayout.add_child(types);
        const bodyLabel = new St.Label({ text: '' });
        this.contentLayout.add_child(bodyLabel);
        const scroll = new St.ScrollView({ style_class: 'ci-set-body-scroll' });
        body = new St.Entry({
          text,
          can_focus: true,
          accessible_name: _('Text to paste'),
          style_class: 'ci-set-body',
        });
        body.clutter_text.single_line_mode = false;
        body.clutter_text.activatable = false;
        body.clutter_text.line_wrap = true;
        body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        const bodyBox = new St.BoxLayout({});
        bodyBox.add_child(body);
        scroll.add_child(bodyBox);
        this.contentLayout.add_child(scroll);
        const modes = new St.BoxLayout({
          style_class: 'ci-paste-action-row',
          accessible_name: _('Execution mode'),
        });
        this.contentLayout.add_child(modes);
        const explanation = new St.Label({
          style_class: 'ci-set-error',
          text: '',
        });
        explanation.clutter_text.line_wrap = true;
        explanation.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        explanation.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.contentLayout.add_child(explanation);
        const trim = new St.Button({
          can_focus: true,
          accessible_role: Atk.Role.TOGGLE_BUTTON,
          style_class: 'ci-paste-action-choice',
        });
        this.contentLayout.add_child(trim);
        const preview = new St.Button({
          can_focus: true,
          accessible_role: Atk.Role.TOGGLE_BUTTON,
          style_class: 'ci-paste-action-choice',
        });
        this.contentLayout.add_child(preview);
        const controls = new St.BoxLayout({
          style_class: 'ci-paste-action-row',
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
        this.contentLayout.add_child(controls);
        this._editorStatus = new St.Label({
          text: _('Command output'),
          style_class: 'ci-set-error',
        });
        this._editorStatus.clutter_text.line_wrap = true;
        this._editorStatus.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.contentLayout.add_child(this._editorStatus);
        const outputScroll = new St.ScrollView({
          style_class: 'ci-editor-output-scroll',
        });
        outputScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._editorOutput = new St.Entry({
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
            ensureActorVisibleInScrollView(
              this._editorScroll,
              this._editorOutput,
            );
        });
        this._editorStop.connect('clicked', () => {
          this._cancelCommandPreview();
          this._editorStatus.text = _('Preview stopped');
        });
        body.clutter_text.connect('text-changed', () =>
          this._cancelCommandPreview(),
        );
        const typeButtons = [];
        const modeButtons = [];
        const sync = () => {
          this._cancelCommandPreview();
          const command = kind === 'command';
          bodyLabel.set_text(
            command
              ? executionMode === 'bash'
                ? _('Bash one-liner')
                : _('Command and arguments')
              : _('Text (line breaks are preserved)'),
          );
          body.accessible_name = command
            ? _('Command to execute')
            : _('Text to paste');
          body.hint_text = command ? "date '+%Y-%m-%d %H:%M:%S'" : '';
          explanation.visible =
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
          preview.label = `${previewOnOpen ? '☑' : '☐'} ${_(
            'Preview output when opening this tab',
          )}`;
          preview.accessible_name = format(
            _('Preview output when opening this tab: %s'),
            previewOnOpen ? _('On') : _('Off'),
          );
          if (previewOnOpen)
            preview.add_accessible_state(Atk.StateType.CHECKED);
          else preview.remove_accessible_state(Atk.StateType.CHECKED);
          trim.label = `${trimTrailingNewlines ? '☑' : '☐'} ${_(
            'Trim trailing newlines',
          )}`;
          trim.accessible_name = format(
            _('Trim trailing newlines: %s'),
            trimTrailingNewlines ? _('On') : _('Off'),
          );
          if (trimTrailingNewlines)
            trim.add_accessible_state(Atk.StateType.CHECKED);
          else trim.remove_accessible_state(Atk.StateType.CHECKED);
          for (const [value, button] of typeButtons) {
            if (kind === value) {
              button.add_style_pseudo_class('checked');
              button.add_accessible_state(Atk.StateType.CHECKED);
            } else {
              button.remove_style_pseudo_class('checked');
              button.remove_accessible_state(Atk.StateType.CHECKED);
            }
          }
          for (const [value, button] of modeButtons) {
            if (executionMode === value) {
              button.add_style_pseudo_class('checked');
              button.add_accessible_state(Atk.StateType.CHECKED);
            } else {
              button.remove_style_pseudo_class('checked');
              button.remove_accessible_state(Atk.StateType.CHECKED);
            }
          }
        };
        for (const [value, label] of [
          ['text', _('Text')],
          ['command', _('Command')],
        ]) {
          const button = new St.Button({
            label,
            can_focus: true,
            accessible_role: Atk.Role.RADIO_BUTTON,
            style_class: 'ci-paste-action-choice',
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
          const button = new St.Button({
            label,
            can_focus: true,
            accessible_role: Atk.Role.RADIO_BUTTON,
            style_class: 'ci-paste-action-choice',
          });
          button.connect('clicked', () => {
            executionMode = value;
            sync();
          });
          modeButtons.push([value, button]);
          modes.add_child(button);
        }
        preview.connect('clicked', () => {
          previewOnOpen = !previewOnOpen;
          sync();
        });
        trim.connect('clicked', () => {
          trimTrailingNewlines = !trimTrailingNewlines;
          sync();
        });
        sync();
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
        const contents = new St.BoxLayout({ x_expand: true });
        contents.set_vertical(true);
        for (const child of this.contentLayout.get_children()) {
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
            if (focus && editorScroll.contains(focus))
              ensureActorVisibleInScrollView(editorScroll, focus);
          },
          this,
        );
      }
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
      this._setCommandPreviewState('', _('Command output'));
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
          this._setCommandPreviewState(text, _('Command output'));
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
