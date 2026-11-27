import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';
import { _ } from './i18n.js';

const batchSize = 64;
function readAsync(object, method, finish, ...args) {
  return new Promise((resolve, reject) =>
    object[method](...args, (source, result) => {
      try {
        resolve(source[finish](result));
      } catch (error) {
        reject(error);
      }
    }),
  );
}
export const isPathQuery = (text) =>
  text.startsWith('/') || text.startsWith('~/');

export class PathExplorer {
  constructor(entry, paste) {
    this.entry = entry;
    this.paste = paste;
    this.actor = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      visible: false,
    });
    this.actor.add_child(
      new St.Label({
        text: _('Path exploration · Tab to complete, Enter to paste'),
      }),
    );
    this.scroll = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    this.list = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
    this.scroll.add_child(this.list);
    this.actor.add_child(this.scroll);
  }

  start() {
    this.original = this.entry.get_text();
    this.actor.show();
    this.entry.clutter_text.grab_key_focus();
    if (this.original === '~') {
      this.entry.set_text('~/');
      this.entry.clutter_text.set_cursor_position(-1);
    } else {
      if (!this.original.endsWith('/')) this.pendingCompletion = this.original;
      this.update();
    }
  }

  stop() {
    this.actor.hide();
    this.cancel?.cancel();
    this.cancel = null;
    this.pendingCompletion = null;
    this.directory = null;
    this.files = null;
    this.rows = [];
    this.matches = [];
    this.list.destroy_all_children();
    const original = this.original;
    this.original = this.base = this.prefix = null;
    return original;
  }

  async update({ retry = false } = {}) {
    const query = this.entry.get_text();
    if (this.pendingCompletion !== query) this.pendingCompletion = null;
    const split = query.lastIndexOf('/') + 1;
    this.base = query.slice(0, split);
    this.prefix = query.slice(split);
    const directory = isPathQuery(query)
      ? this.base.replace(/^~(?=\/)/, () => GLib.get_home_dir())
      : null;
    if (!retry && directory && this.directory === directory) {
      if (this.files) this.render();
      return;
    }
    this.cancel?.cancel();
    this.directory = directory;
    this.files = null;
    this.matches = [];
    this.message(
      directory
        ? _('Reading folder…')
        : _('Enter a path starting with / or ~/'),
    );
    if (!directory) return;
    const cancel = new Gio.Cancellable();
    this.cancel = cancel;
    let enumerator;
    try {
      const parent = Gio.File.new_for_path(directory);
      enumerator = await readAsync(
        parent,
        'enumerate_children_async',
        'enumerate_children_finish',
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        cancel,
      );
      const files = [];
      while (!cancel.is_cancelled()) {
        const batch = await readAsync(
          enumerator,
          'next_files_async',
          'next_files_finish',
          batchSize,
          GLib.PRIORITY_DEFAULT,
          cancel,
        );
        if (!batch.length) break;
        for (const info of batch) {
          let name;
          try {
            name = info.get_name();
          } catch {
            // Unix filenames that GJS cannot decode cannot be pasted as text.
            continue;
          }
          const folder = info.get_file_type() === Gio.FileType.DIRECTORY;
          files.push({ name, suffix: name + (folder ? '/' : ''), folder });
        }
      }
      if (cancel.is_cancelled()) return;
      this.files = files.sort(
        (a, b) =>
          Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name),
      );
      this.render();
      if (this.pendingCompletion === this.entry.get_text()) {
        this.pendingCompletion = null;
        if (
          this.entry.clutter_text.has_key_focus() &&
          !this.entry.clutter_text.has_preedit()
        )
          this.complete();
      }
    } catch (error) {
      if (!cancel.is_cancelled()) {
        this.pendingCompletion = null;
        this.message(error.message);
      }
    } finally {
      if (this.cancel === cancel) this.cancel = null;
      if (enumerator) {
        try {
          await readAsync(
            enumerator,
            'close_async',
            'close_finish',
            GLib.PRIORITY_DEFAULT,
            null,
          );
        } catch (error) {
          if (!cancel.is_cancelled()) console.error(error);
        }
      }
    }
  }

  message(text) {
    this.rows = [];
    this.list.destroy_all_children();
    this.list.add_child(new St.Label({ text }));
  }

  render() {
    this.matches = this.files.filter(
      (file) =>
        file.name.startsWith(this.prefix) &&
        (!file.name.startsWith('.') || this.prefix.startsWith('.')),
    );
    this.list.destroy_all_children();
    this.scroll.vadjustment.value = 0;
    this.rows = [];
    if (!this.matches.length) this.message(_('No matching paths'));
    else this.appendRows();
  }

  appendRows() {
    this.more?.destroy();
    this.more = null;
    for (const file of this.matches.slice(
      this.rows.length,
      this.rows.length + batchSize,
    )) {
      const row = new St.Button({
        style_class: 'popup-menu-item ci-path-row',
        can_focus: true,
        x_expand: true,
        child: new St.Label({
          text: file.suffix,
          x_expand: true,
          x_align: Clutter.ActorAlign.FILL,
        }),
      });
      row.accessible_name = file.suffix;
      row.connect('clicked', () => this.accept(file));
      row.connect('key-focus-in', () =>
        ensureActorVisibleInScrollView(this.scroll, row),
      );
      this.list.add_child(row);
      this.rows.push(row);
    }
    if (this.rows.length < this.matches.length) {
      this.more = new St.Button({
        label: _('Show more paths'),
        can_focus: true,
      });
      this.more.connect('clicked', () => {
        const next = this.rows.length;
        this.appendRows();
        this.rows[next]?.grab_key_focus();
      });
      this.list.add_child(this.more);
      this.more.connect('destroy', () => {
        this.more = null;
      });
    }
  }

  accept(file) {
    const path = Gio.File.new_for_path(this.directory)
      .get_child(file.name)
      .get_path();
    this.paste(path + (file.folder ? '/' : ''));
  }

  complete(chosen) {
    if (!this.matches.length) return;
    let suffix = (chosen || this.matches[0]).suffix;
    if (!chosen) {
      for (const file of this.matches) {
        while (!file.suffix.startsWith(suffix))
          suffix = Array.from(suffix).slice(0, -1).join('');
        if (suffix === this.prefix) break;
      }
    }
    this.entry.clutter_text.grab_key_focus();
    this.entry.set_text(this.base + suffix);
    this.entry.clutter_text.set_cursor_position(-1);
  }

  handleKey(event, inEntry) {
    const symbol = event.get_key_symbol();
    const index = this.rows?.indexOf(global.stage.get_key_focus()) ?? -1;
    const chosen = this.matches[index];
    if (inEntry && this.entry.clutter_text.has_preedit()) return false;
    if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up) {
      if (!this.matches.length) return true;
      const next =
        symbol === Clutter.KEY_Down
          ? Math.min(index + 1, this.matches.length - 1)
          : index < 0
            ? this.rows.length - 1
            : index - 1;
      if (next >= this.rows.length) this.appendRows();
      (this.rows[next] || this.entry.clutter_text).grab_key_focus();
      return true;
    }
    if (symbol === Clutter.KEY_Tab) {
      if (inEntry && !this.files && this.directory) {
        this.pendingCompletion = this.entry.get_text();
        if (!this.cancel) this.update({ retry: true });
      } else this.complete(chosen);
      return true;
    }
    if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
      if (inEntry && this.files && !this.prefix) {
        const path = Gio.File.new_for_path(this.directory).get_path();
        this.paste(path.endsWith('/') ? path : path + '/');
      } else if (chosen || (inEntry && this.matches.length === 1))
        this.accept(chosen || this.matches[0]);
      else if (global.stage.get_key_focus() === this.more && this.more)
        this.more.emit('clicked', 1);
      return true;
    }
    return false;
  }
}
