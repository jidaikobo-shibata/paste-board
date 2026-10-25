import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const PasteSetDialog = GObject.registerClass(
  class PasteSetDialog extends ModalDialog.ModalDialog {
    _init(title, name, text, save, remove = null) {
      super._init();
      this.contentLayout.add_child(new St.Label({text: title}));
      const nameInput = new St.Entry({text: name, can_focus: true,
        accessible_name: '名前', hint_text: '名前'});
      nameInput.clutter_text.set_max_length(text === null ? 100 : 200);
      this.contentLayout.add_child(nameInput);
      let body;
      if (text !== null) {
        this.contentLayout.add_child(new St.Label({text: '本文（改行もそのまま保存）'}));
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
      }
      const error = new St.Label({text: '', style_class: 'ci-set-error'});
      error.clutter_text.line_wrap = true;
      this.contentLayout.add_child(error);
      const commit = () => {
        try {
          save(nameInput.get_text().trim(), body?.get_text());
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
