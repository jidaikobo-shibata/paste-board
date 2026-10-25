import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Atk from 'gi://Atk';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const PasteSetDialog = GObject.registerClass(
  class PasteSetDialog extends ModalDialog.ModalDialog {
    _init(title, name, text, save, remove = null, options = {}) {
      super._init();
      this.contentLayout.add_child(new St.Label({text: title}));
      const nameInput = new St.Entry({text: name, can_focus: true,
        accessible_name: '名前', hint_text: '名前'});
      nameInput.clutter_text.set_max_length(text === null ? 100 : 200);
      this.contentLayout.add_child(nameInput);
      let body;
      let kind = options.kind || 'text';
      let executionMode = options.executionMode || 'direct';
      let trimTrailingNewlines = options.trimTrailingNewlines !== false;
      if (text !== null) {
        const types = new St.BoxLayout({style_class: 'ci-paste-action-row'});
        this.contentLayout.add_child(types);
        const bodyLabel = new St.Label({text: ''});
        this.contentLayout.add_child(bodyLabel);
        const scroll = new St.ScrollView({style_class: 'ci-set-body-scroll'});
        body = new St.Entry({text, can_focus: true, accessible_name: '貼り付ける本文',
          style_class: 'ci-set-body'});
        body.clutter_text.single_line_mode = false;
        body.clutter_text.activatable = false;
        body.clutter_text.line_wrap = true;
        const bodyBox = new St.BoxLayout({});
        bodyBox.add_child(body);
        scroll.add_child(bodyBox);
        this.contentLayout.add_child(scroll);
        const modes = new St.BoxLayout({style_class: 'ci-paste-action-row', accessible_name: '実行方式'});
        this.contentLayout.add_child(modes);
        const explanation = new St.Label({style_class: 'ci-set-error',
          text: ''});
        explanation.clutter_text.line_wrap = true;
        this.contentLayout.add_child(explanation);
        const trim = new St.Button({can_focus: true, accessible_role: Atk.Role.TOGGLE_BUTTON,
          style_class: 'ci-paste-action-choice'});
        this.contentLayout.add_child(trim);
        const typeButtons = [];
        const modeButtons = [];
        const sync = () => {
          const command = kind === 'command';
          bodyLabel.set_text(command
            ? executionMode === 'bash' ? 'Bashワンライナー' : 'コマンドと引数'
            : '本文（改行もそのまま保存）');
          body.accessible_name = command ? '実行するコマンド' : '貼り付ける本文';
          body.hint_text = command ? "date '+%Y-%m-%d %H:%M:%S'" : '';
          explanation.visible = trim.visible = modes.visible = command;
          explanation.set_text((executionMode === 'bash'
            ? '貼付時にBashで実行します。パイプ・変数展開が使えます。\n'
            : '貼付時に直接実行します。パイプ・変数展開は行いません。\n')
            + 'あなたの権限で実行され、ファイルの変更・削除や外部への通信も可能です。'
            + '出力がなくても実行されます。内容を理解し、信頼できるコマンドだけを登録してください。\n'
            + '対話入力には対応しません。パスワードの取得・保存・受け渡しは行いません。\n'
            + '制限は3秒・出力64KiBです。実行済みの操作は取り消せません。');
          trim.label = `${trimTrailingNewlines ? '☑' : '☐'} 末尾の改行を削除する`;
          trim.accessible_name = `末尾の改行を削除する：${trimTrailingNewlines ? 'オン' : 'オフ'}`;
          if (trimTrailingNewlines) trim.add_accessible_state(Atk.StateType.CHECKED);
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
        for (const [value, label] of [['text', 'テキスト'], ['command', 'コマンド']]) {
          const button = new St.Button({label, can_focus: true,
            accessible_role: Atk.Role.RADIO_BUTTON, style_class: 'ci-paste-action-choice'});
          button.connect('clicked', () => {kind = value; sync();});
          typeButtons.push([value, button]);
          types.add_child(button);
        }
        for (const [value, label] of [['direct', '直接実行'], ['bash', 'Bash（ワンライナー）']]) {
          const button = new St.Button({label, can_focus: true,
            accessible_role: Atk.Role.RADIO_BUTTON, style_class: 'ci-paste-action-choice'});
          button.connect('clicked', () => {executionMode = value; sync();});
          modeButtons.push([value, button]);
          modes.add_child(button);
        }
        trim.connect('clicked', () => {trimTrailingNewlines = !trimTrailingNewlines; sync();});
        sync();
      }
      const error = new St.Label({text: '', style_class: 'ci-set-error'});
      error.clutter_text.line_wrap = true;
      this.contentLayout.add_child(error);
      const commit = () => {
        try {
          save(nameInput.get_text().trim(), body?.get_text(), {kind, trimTrailingNewlines, executionMode});
          this.close();
        } catch (e) {error.set_text(e.message);}
      };
      if (!body) nameInput.clutter_text.connect('activate', commit);
      const buttons = [
        {label: 'キャンセル', key: Clutter.KEY_Escape, action: () => this.close()},
        {label: '保存', action: commit},
      ];
      if (remove) buttons.unshift({label: 'タブを削除', action: () => {
        this.connect('closed', remove);
        this.close();
      }});
      this.setButtons(buttons);
      this.setInitialKeyFocus(nameInput);
    }
  },
);

export const PasteSetTargetDialog = GObject.registerClass(
  class PasteSetTargetDialog extends ModalDialog.ModalDialog {
    _init(sets, choose) {
      super._init();
      this.contentLayout.add_child(new St.Label({text: '追加先のペーストセット'}));
      const scroll = new St.ScrollView({style_class: 'ci-set-targets'});
      const list = new St.BoxLayout({});
      list.set_vertical(true);
      scroll.add_child(list);
      this.contentLayout.add_child(scroll);
      const error = new St.Label({text: ''});
      this.contentLayout.add_child(error);
      for (const set of sets) {
        const button = new St.Button({label: set.name, can_focus: true, style_class: 'ci-paste-action-choice'});
        button.connect('clicked', () => {
          try {choose(set.id); this.close();}
          catch (e) {error.set_text(e.message);}
        });
        list.add_child(button);
      }
      this.setButtons([{label: 'キャンセル', key: Clutter.KEY_Escape, action: () => this.close()}]);
      this.setInitialKeyFocus(list.get_first_child());
    }
  },
);
