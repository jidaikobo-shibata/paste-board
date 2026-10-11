import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const FavoriteNameDialog = GObject.registerClass(
  class FavoriteNameDialog extends ModalDialog.ModalDialog {
    _init(name, save) {
      super._init();
      const label = new St.Label({text: 'お気に入りの名前'});
      this.contentLayout.add_child(label);
      const input = new St.Entry({text: name, can_focus: true,
        accessible_name: 'お気に入りの名前', hint_text: '空欄にすると本文を表示します'});
      input.clutter_text.set_max_length(200);
      this.contentLayout.add_child(input);
      const error = new St.Label({text: '', accessible_name: '保存結果'});
      this.contentLayout.add_child(error);
      const commit = () => {
        try {
          save(input.get_text().replace(/\0/g, '').trim());
          this.close();
        } catch {
          error.set_text('保存できませんでした。名前を変更せずにキャンセルできます。');
        }
      };
      input.clutter_text.connect('activate', commit);
      this.setButtons([
        {label: 'キャンセル', key: Clutter.KEY_Escape, action: () => this.close()},
        {label: '保存', action: commit},
      ]);
      this.setInitialKeyFocus(input);
    }
  },
);
