import { _ } from './i18n.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Owns only the visual feedback and its timers; recording/paste policy stays
// with the indicator. No resources are acquired until an instance is created.
export class CopyFeedback {
  constructor(icon, notify) {
    this.icon = icon;
    this.notify = notify;
  }

  destroy() {
    this.clear();
    this._destroyed = true;
    this.icon = null;
    this.notify = null;
  }

  clear() {
    if (this._copyPanelFlashTimer) {
      GLib.Source.remove(this._copyPanelFlashTimer);
      this._copyPanelFlashTimer = undefined;
    }
    if (this._copyHighlightTimer) {
      GLib.Source.remove(this._copyHighlightTimer);
      this._copyHighlightTimer = undefined;
    }
    this.icon?.remove_style_class_name('copy-highlight');
    if (this._copyBubble) {
      this._copyBubble.destroy();
      this._copyBubble = undefined;
    }
    this._copyPanelFlash?.destroy();
    this._copyPanelFlash = undefined;
  }

  show(mode) {
    if (this._destroyed) return;
    this.clear();
    if (mode === 0) return;
    if (mode === 4) {
      this.notify(_('Copied'), '');
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
        this.clear();
        return GLib.SOURCE_REMOVE;
      },
    );
  }
}
