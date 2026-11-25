import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { _, format } from './i18n.js';
import { PasteSets } from './pasteSets.js';
import { textFitsLimit } from './inputLimits.js';

export const BACKUP_LIMIT = 32 * 1024 * 1024;
export const BACKUP_PATH = '/org/gnome/Shell/Extensions/PasteBoard';
export const BACKUP_INTERFACE = 'org.gnome.Shell.Extensions.PasteBoard';
const SHORTCUT_KEYS = new Set([
  'enable-keybindings',
  'toggle-menu',
  'quick-paste-modifiers',
  'application-paste-shortcuts',
]);
const INTERFACE_XML = `<node><interface name="${BACKUP_INTERFACE}">
<method name="Export"><arg type="s" direction="out"/></method>
<method name="Import"><arg type="s" direction="in"/><arg type="b" direction="in"/><arg type="b" direction="in"/><arg type="s" direction="in"/></method>
</interface></node>`;

export function parseBackup(json, settings) {
  if (!textFitsLimit(json, BACKUP_LIMIT))
    throw new Error(_('The backup file is too large.'));
  const data = JSON.parse(json);
  if (
    data?.format !== 'paste-board' ||
    data.version !== 1 ||
    !data.preferences ||
    typeof data.preferences !== 'object' ||
    Array.isArray(data.preferences)
  )
    throw new Error(_('Invalid Paste Board backup.'));
  PasteSets.validate({
    version: 1,
    sets: data.sets,
    ...(data.historyName === undefined
      ? {}
      : { historyName: data.historyName }),
  });
  const schema = settings.settings_schema;
  for (const [key, value] of Object.entries(data.preferences)) {
    if (!schema.has_key(key) || typeof value !== 'string')
      throw new Error(_('Invalid backup preferences.'));
    const schemaKey = schema.get_key(key);
    const variant = GLib.Variant.parse(
      schemaKey.get_value_type(),
      value,
      null,
      null,
    );
    if (!schemaKey.range_check(variant))
      throw new Error(_('Invalid backup preferences.'));
  }
  return data;
}

export function createBackup(pasteSets, settings) {
  const preferences = {};
  for (const key of settings.settings_schema.list_keys())
    if (key !== 'debug-mode')
      preferences[key] = settings.get_value(key).print(true);
  const data = {
    format: 'paste-board',
    version: 1,
    sets: pasteSets.data.sets,
    ...(pasteSets.data.historyName === undefined
      ? {}
      : { historyName: pasteSets.data.historyName }),
    preferences,
  };
  const json = JSON.stringify(data, null, 2);
  parseBackup(json, settings);
  return json;
}

// This operates on the Shell's single writer. Stable operation IDs make retries
// after a failed write add the imported sets only once.
export async function importBackup(
  pasteSets,
  settings,
  json,
  applyPreferences,
  applyShortcuts,
  operationId,
  isActive = () => true,
) {
  const data = parseBackup(json, settings);
  if (!isActive()) throw new Error(_('Paste Board is not available.'));
  if (!/^[0-9a-f-]{36}$/i.test(operationId))
    throw new Error(_('Invalid import request.'));
  const pending = new Gio.Settings({
    settings_schema: settings.settings_schema,
  });
  pending.delay();
  if (applyPreferences)
    for (const [key, value] of Object.entries(data.preferences)) {
      if (key === 'debug-mode' || (!applyShortcuts && SHORTCUT_KEYS.has(key)))
        continue;
      if (!settings.is_writable(key))
        throw new Error(_('Some preferences cannot be changed.'));
      const variant = GLib.Variant.parse(
        settings.settings_schema.get_key(key).get_value_type(),
        value,
        null,
        null,
      );
      if (!pending.set_value(key, variant))
        throw new Error(_('Could not apply backup preferences.'));
    }
  // A backup can contain sets created before its saved item limit was lowered.
  // When restoring that limit, preserve those items just as a local edit would.
  // The persisted format and storage size limits still apply.
  const itemLimit =
    applyPreferences && Object.hasOwn(data.preferences, 'history-size')
      ? Infinity
      : settings.get_int('history-size');
  if (!(pasteSets.data.importReceipts || []).includes(operationId)) {
    await pasteSets.changeAndSave(
      (sets, next) => {
        const names = new Set(sets.map((set) => set.name));
        for (const source of data.sets) {
          let name = source.name;
          for (let number = 2; names.has(name); number++)
            name = format(
              _('%s (%d)'),
              source.name.slice(0, 85).replace(/[\uD800-\uDBFF]$/, ''),
              number,
            );
          names.add(name);
          const set = { id: GLib.uuid_string_random(), name, items: [] };
          if (source.kind === 'generated')
            Object.assign(set, {
              kind: 'generated',
              command: source.command,
              executionMode: source.executionMode,
              runOnOpen: false,
              runOnSearch: false,
            });
          else
            set.items = source.items.map((item) => {
              const copy = pasteSets._copyItem(item);
              if (copy.kind === 'command') copy.previewOnOpen = false;
              return copy;
            });
          sets.push(set);
        }
        if (applyPreferences && data.historyName !== undefined)
          next.historyName = data.historyName;
        next.importReceipts = [
          ...(next.importReceipts || []),
          operationId,
        ].slice(-32);
      },
      { itemLimit },
    );
  }
  await pasteSets.flush();
  if (!isActive()) throw new Error(_('Paste Board is not available.'));
  if (applyPreferences) pending.apply();
}

export class BackupService {
  constructor(pasteSets, settings, changed) {
    this.pasteSets = pasteSets;
    this.settings = settings;
    this.changed = changed;
    this.object = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
    this.object.export(Gio.DBus.session, BACKUP_PATH);
  }
  ExportAsync(_args, invocation) {
    try {
      invocation.return_value(
        new GLib.Variant('(s)', [createBackup(this.pasteSets, this.settings)]),
      );
    } catch (error) {
      invocation.return_dbus_error(BACKUP_INTERFACE + '.Error', error.message);
    }
  }
  async ImportAsync(args, invocation) {
    if (this.busy || this.closed) {
      invocation.return_dbus_error(
        BACKUP_INTERFACE + '.Busy',
        _('Another import is in progress.'),
      );
      return;
    }
    this.busy = true;
    try {
      await importBackup(
        this.pasteSets,
        this.settings,
        ...args,
        () => !this.closed,
      );
      invocation.return_value(null);
    } catch (error) {
      // The receipt and imported sets are committed in the same file write.
      const committed = this.pasteSets.data.importReceipts?.includes(args[3]);
      const suffix = committed || this.closed ? '.Error' : '.NotApplied';
      invocation.return_dbus_error(BACKUP_INTERFACE + suffix, error.message);
    } finally {
      this.busy = false;
      if (!this.closed) this.changed();
    }
  }
  destroy() {
    this.closed = true;
    this.object.unexport();
  }
}
