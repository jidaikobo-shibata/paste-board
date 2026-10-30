import GLib from 'gi://GLib';
import { _ } from './i18n.js';

export const SETTINGS_KEY = 'application-paste-shortcuts';
export const PRESETS = Object.freeze([
  Object.freeze({ keyval: 0x76, modifiers: 1 }),
  Object.freeze({ keyval: 0x76, modifiers: 5 }),
  Object.freeze({ keyval: 0xff63, modifiers: 4 }),
]);

export function validAppId(id) {
  return (
    typeof id === 'string' &&
    id.length > 8 &&
    id.length <= 255 &&
    id.endsWith('.desktop') &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(id)
  );
}

export function modifierKey(keyval) {
  return (
    (keyval >= 0xffe1 && keyval <= 0xffee) ||
    [0xff7f, 0xfe03, 0xfe11].includes(keyval)
  );
}

export function validShortcut(shortcut) {
  return (
    Number.isInteger(shortcut?.keyval) &&
    shortcut.keyval > 0 &&
    shortcut.keyval <= 0x1fffffff &&
    !modifierKey(shortcut.keyval) &&
    Number.isInteger(shortcut.modifiers) &&
    shortcut.modifiers >= 1 &&
    shortcut.modifiers <= 15
  );
}

export function readOverrides(settings) {
  const result = Object.create(null);
  const saved = settings.get_value(SETTINGS_KEY).deep_unpack();
  for (const [id, value] of Object.entries(saved)) {
    if (!validAppId(id) || !Array.isArray(value) || value.length !== 2)
      continue;
    const shortcut = { keyval: value[0], modifiers: value[1] };
    if (validShortcut(shortcut)) result[id] = shortcut;
  }
  return result;
}

export function writeOverride(settings, appId, shortcut) {
  if (!validAppId(appId) || (shortcut !== null && !validShortcut(shortcut)))
    throw new Error(_('Invalid application or paste shortcut.'));
  const overrides = readOverrides(settings);
  if (shortcut === null) delete overrides[appId];
  else
    overrides[appId] = {
      keyval: shortcut.keyval,
      modifiers: shortcut.modifiers,
    };
  if (Object.keys(overrides).length > 100)
    throw new Error(_('Up to 100 application shortcuts can be saved.'));
  const data = Object.create(null);
  for (const [id, value] of Object.entries(overrides))
    data[id] = [value.keyval, value.modifiers];
  if (!settings.set_value(SETTINGS_KEY, new GLib.Variant('a{s(uu)}', data)))
    throw new Error(_('Could not save application shortcuts.'));
}

export function resolveShortcut(overrides, appId) {
  const custom = Object.hasOwn(overrides, appId) ? overrides[appId] : null;
  if (validShortcut(custom)) return Object.freeze({ ...custom, custom: true });
  // Keep the existing automatic behavior, including customized Ptyxis setups.
  const terminal =
    /terminal|console|kitty|alacritty|wezterm|ghostty|foot|konsole|xterm|tilix|terminator/i.test(
      appId,
    );
  return Object.freeze({
    keyval: 0x76,
    modifiers: terminal ? 5 : 1,
    custom: false,
  });
}

// Resolve modifiers as well as the main key by meaning, honoring the active keymap.
// The caller waits for physical keys to be released before using this device.
export function sendShortcut(keyboard, shortcut, time, states) {
  if (!validShortcut(shortcut)) throw new Error(_('Invalid paste shortcut.'));
  const held = [];
  let keyAttempted = false;
  let failure;
  try {
    for (const [bit, code] of [
      [1, 0xffe3],
      [2, 0xffe9],
      [4, 0xffe1],
      [8, 0xffeb],
    ]) {
      if (!(shortcut.modifiers & bit)) continue;
      held.push(code);
      keyboard.notify_keyval(time, code, states.PRESSED);
    }
    keyAttempted = true;
    keyboard.notify_keyval(time, shortcut.keyval, states.PRESSED);
  } catch (error) {
    failure = error;
  } finally {
    if (keyAttempted) {
      try {
        keyboard.notify_keyval(time, shortcut.keyval, states.RELEASED);
      } catch (error) {
        failure ??= error;
      }
    }
    for (const code of held.reverse()) {
      try {
        keyboard.notify_keyval(time, code, states.RELEASED);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
}
