import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
  SETTINGS_KEY,
  PRESETS,
  validAppId,
  validShortcut,
  readOverrides,
  writeOverride,
  resolveShortcut,
  sendShortcut,
} from '../pasteShortcuts.js';
const directory = Gio.File.new_for_uri(import.meta.url)
  .get_parent()
  .get_parent()
  .get_child('schemas')
  .get_path();
const source = Gio.SettingsSchemaSource.new_from_directory(
  directory,
  Gio.SettingsSchemaSource.get_default(),
  false,
);
const settings = new Gio.Settings({
  settings_schema: source.lookup(
    'org.gnome.shell.extensions.paste-board',
    true,
  ),
});
let count = 0;
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  count++;
}
function rejects(fn) {
  let rejected = false;
  try {
    fn();
  } catch {
    rejected = true;
  }
  equal(rejected, true);
}
equal(readOverrides(settings), {});
for (const id of [
  'org.gnome.Ptyxis.desktop',
  'chromium_chromium.desktop',
  'my-app.desktop',
])
  equal(validAppId(id), true);
for (const id of [
  'window:1',
  '../foo.desktop',
  'foo\n.desktop',
  'foo\\bar.desktop',
  'a'.repeat(256) + '.desktop',
])
  equal(validAppId(id), false);
for (const key of PRESETS) equal(validShortcut(key), true);
for (const key of [
  { keyval: 0, modifiers: 1 },
  { keyval: 118, modifiers: 0 },
  { keyval: 118, modifiers: 16 },
  { keyval: 0xffe3, modifiers: 1 },
  { keyval: 1.5, modifiers: 1 },
])
  equal(validShortcut(key), false);
equal(resolveShortcut({}, 'org.gnome.Ptyxis.desktop').modifiers, 1);
equal(resolveShortcut({}, 'org.gnome.Terminal.desktop').modifiers, 5);
equal(resolveShortcut({}, 'org.gnome.Console.desktop').modifiers, 5);
equal(resolveShortcut({}, 'firefox.desktop').custom, false);
writeOverride(settings, 'org.gnome.Ptyxis.desktop', PRESETS[1]);
equal(readOverrides(settings)['org.gnome.Ptyxis.desktop'], PRESETS[1]);
const selected = resolveShortcut(
  readOverrides(settings),
  'org.gnome.Ptyxis.desktop',
);
equal(selected, { ...PRESETS[1], custom: true });
writeOverride(settings, 'org.gnome.Ptyxis.desktop', PRESETS[0]);
equal(selected.modifiers, 5); // Captured decisions do not follow later edits.
writeOverride(settings, 'firefox.desktop', { keyval: 121, modifiers: 1 });
equal(resolveShortcut(readOverrides(settings), 'firefox.desktop').keyval, 121);
writeOverride(settings, 'org.gnome.Ptyxis.desktop', null);
equal(
  resolveShortcut(readOverrides(settings), 'org.gnome.Ptyxis.desktop').custom,
  false,
);
equal(readOverrides(settings)['firefox.desktop'].keyval, 121);
rejects(() => writeOverride(settings, 'window:1', PRESETS[0]));
settings.set_value(
  SETTINGS_KEY,
  new GLib.Variant('a{s(uu)}', {
    'bad.desktop': [0, 0],
    'window:1': [118, 1],
    'valid.desktop': [118, 1],
  }),
);
equal(Object.keys(readOverrides(settings)), ['valid.desktop']);
const many = {};
for (let i = 0; i < 100; i++) many['app' + i + '.desktop'] = [118, 1];
settings.set_value(SETTINGS_KEY, new GLib.Variant('a{s(uu)}', many));
rejects(() => writeOverride(settings, 'extra.desktop', PRESETS[0]));
equal(Object.keys(readOverrides(settings)).length, 100);
writeOverride(settings, 'app0.desktop', null);
equal(Object.keys(readOverrides(settings)).length, 99);
for (const [shortcut, codes] of [
  [PRESETS[0], [0xffe3]],
  [PRESETS[1], [0xffe3, 0xffe1]],
  [PRESETS[2], [0xffe1]],
  [{ keyval: 121, modifiers: 15 }, [0xffe3, 0xffe9, 0xffe1, 0xffeb]],
]) {
  const events = [];
  const keyboard = {
    notify_key: (time, code, state) => events.push(['code', code, state]),
    notify_keyval: (time, key, state) => events.push(['value', key, state]),
  };
  sendShortcut(keyboard, shortcut, 123, { PRESSED: 1, RELEASED: 0 });
  equal(events, [
    ...codes.map((code) => ['value', code, 1]),
    ['value', shortcut.keyval, 1],
    ['value', shortcut.keyval, 0],
    ...codes
      .slice()
      .reverse()
      .map((code) => ['value', code, 0]),
  ]);
}
const events = [];
rejects(() =>
  sendShortcut(
    {
      notify_keyval(time, key, state) {
        events.push([key, state]);
        if (key === 118 && state === 1)
          throw new Error('test injection failure');
      },
    },
    PRESETS[1],
    123,
    { PRESSED: 1, RELEASED: 0 },
  ),
);
equal(events, [
  [0xffe3, 1],
  [0xffe1, 1],
  [118, 1],
  [118, 0],
  [0xffe1, 0],
  [0xffe3, 0],
]);
settings.reset(SETTINGS_KEY);
print(`Application paste shortcuts: ${count} checks passed`);
