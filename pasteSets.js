import {_, format} from './i18n.js';
import GLib from 'gi://GLib';

export class PasteSets {
  constructor(directory) {
    this.path = GLib.build_filenamev([directory, 'paste-sets.json']);
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
      throw new Error(_("Could not create the paste set directory."));
    if (GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
      const [ok, bytes] = GLib.file_get_contents(this.path);
      if (!ok || bytes.length > 16 * 1024 * 1024)
        throw new Error(_("Could not read paste sets."));
      this.data = JSON.parse(new TextDecoder().decode(bytes));
      // Omitted discriminators mean plain text and direct command execution.
      // Normalize the persisted format once at the input boundary.
      if (Array.isArray(this.data?.sets)) for (const set of this.data.sets) {
        if (Array.isArray(set?.items)) for (const item of set.items) {
          if (!item || typeof item !== 'object') continue;
          item.kind ??= 'text';
          if (item.kind === 'command') item.executionMode ??= 'direct';
        }
      }
      this._validate(this.data);
    } else {
      this.data = {version: 1, sets: []};
      this._save(this.data);
    }
  }

  _validate(data) {
    if (data?.version !== 1 || !Array.isArray(data.sets) || data.sets.length > 100)
      throw new Error(_("Invalid paste set format."));
    if (data.historyName !== undefined &&
        (typeof data.historyName !== 'string' || !data.historyName.trim() || data.historyName.length > 100))
      throw new Error(_("Invalid history tab name."));
    const ids = new Set();
    for (const set of data.sets) {
      if (typeof set.id !== 'string' || ids.has(set.id) ||
          typeof set.name !== 'string' || !set.name.trim() || set.name.length > 100 ||
          !Array.isArray(set.items) || set.items.length > 1000)
        throw new Error(_("Invalid paste set format."));
      ids.add(set.id);
      for (const item of set.items) {
        if (typeof item.id !== 'string' || ids.has(item.id) ||
            typeof item.name !== 'string' || item.name.length > 200 ||
            !['text', 'command'].includes(item.kind) ||
            typeof item.text !== 'string' || item.text.includes('\0') ||
            (item.kind === 'text' && !item.text))
          throw new Error(_("Invalid paste item format."));
        if (item.kind === 'command' &&
            (typeof item.command !== 'string' || !item.command.trim() ||
             item.command.length > 8192 || item.command.includes('\0') ||
             !['direct', 'bash'].includes(item.executionMode) ||
             typeof item.trimTrailingNewlines !== 'boolean'))
          throw new Error(_("Invalid command item format."));
        ids.add(item.id);
      }
    }
  }

  _save(data) {
    this._validate(data);
    const json = JSON.stringify(data);
    if (new TextEncoder().encode(json).length > 16 * 1024 * 1024)
      throw new Error(_("Paste sets exceed the storage limit."));
    if (!GLib.file_set_contents(this.path, json))
      throw new Error(_("Could not save paste sets."));
  }

  change(update) {
    const next = JSON.parse(JSON.stringify(this.data));
    update(next.sets);
    this._save(next);
    this.data = next;
  }

  create(name) {
    const id = GLib.uuid_string_random();
    this.change(sets => sets.push({id, name: name.trim(), items: []}));
    return id;
  }

  createFromItem(item) {
    const id = GLib.uuid_string_random();
    this.change(sets => {
      const names = new Set([this.data.historyName || _("History"), ...sets.map(set => set.name)]);
      let name = _('untitled');
      for (let number = 2; names.has(name); number++) name = format(_('%s %d'), _('untitled'), number);
      sets.push({id, name, items: [this._copyItem(item)]});
    });
    return id;
  }

  _copyItem(item, previous = null) {
    const kind = item.kind || 'text';
    const next = {id: previous?.id || GLib.uuid_string_random(), name: item.name || '',
      kind, text: kind === 'command' ? '' : item.text};
    if (kind === 'command') {
      next.command = item.command;
      next.executionMode = item.executionMode ?? previous?.executionMode ?? 'direct';
      next.trimTrailingNewlines = item.trimTrailingNewlines !== false;
    }
    return next;
  }

  rename(id, name) {
    this.change(sets => {sets.find(set => set.id === id).name = name.trim();});
  }

  renameHistory(name) {
    const next = {...this.data, historyName: name.trim()};
    this._save(next);
    this.data = next;
  }

  remove(id) {
    this.change(sets => {
      const index = sets.findIndex(set => set.id === id);
      if (index < 0) throw new Error(_("Paste set not found."));
      sets.splice(index, 1);
    });
  }

  put(setId, item) {
    this.change(sets => {
      const set = sets.find(set => set.id === setId);
      const previous = set.items.find(entry => entry.id === item.id);
      const next = this._copyItem(item, previous);
      if (previous)
        set.items[set.items.indexOf(previous)] = next;
      else
        set.items.push(next);
    });
  }

  removeItem(setId, itemId) {
    this.change(sets => {
      const items = sets.find(set => set.id === setId).items;
      const index = items.findIndex(item => item.id === itemId);
      if (index >= 0) items.splice(index, 1);
    });
  }

  moveRelative(setId, itemId, targetId, after) {
    this.change(sets => {
      const items = sets.find(set => set.id === setId)?.items;
      const index = items?.findIndex(item => item.id === itemId) ?? -1;
      if (index < 0 || !items.some(item => item.id === targetId))
        throw new Error(_("The item to move was not found."));
      if (itemId === targetId) return;
      const [item] = items.splice(index, 1);
      const target = items.findIndex(entry => entry.id === targetId);
      items.splice(target + (after ? 1 : 0), 0, item);
    });
  }

  move(setId, itemId, direction) {
    this.change(sets => {
      const items = sets.find(set => set.id === setId).items;
      const index = items.findIndex(item => item.id === itemId);
      const target = index + direction;
      if (index >= 0 && target >= 0 && target < items.length)
        [items[index], items[target]] = [items[target], items[index]];
    });
  }
}
