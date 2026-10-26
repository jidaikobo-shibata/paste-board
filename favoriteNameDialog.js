import {_} from './i18n.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const FavoriteNameDialog = GObject.registerClass(
  class FavoriteNameDialog extends ModalDialog.ModalDialog {
    _init(name, save) {
      super._init();
      const label = new St.Label({text: _("Favorite name")});
      this.contentLayout.add_child(label);
      const input = new St.Entry({text: name, can_focus: true,
        accessible_name: _("Favorite name"), hint_text: _("Leave empty to show the text")});
      input.clutter_text.set_max_length(200);
      this.contentLayout.add_child(input);
      const error = new St.Label({text: '', accessible_name: _("Save status")});
      this.contentLayout.add_child(error);
      const commit = () => {
        try {
          save(input.get_text().replace(/\0/g, '').trim());
          this.close();
        } catch {
          error.set_text(_("Could not save. You can cancel without changing the name."));
        }
      };
      input.clutter_text.connect('activate', commit);
      this.setButtons([
        {label: _("Cancel"), key: Clutter.KEY_Escape, action: () => this.close()},
        {label: _("Save"), action: commit},
      ]);
      this.setInitialKeyFocus(input);
    }
  },
);
