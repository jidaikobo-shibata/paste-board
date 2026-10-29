import Gettext from 'gettext';
import GLib from 'gi://GLib';

export const DOMAIN = 'paste-board';
const directory = GLib.build_filenamev([
  GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
  'locale',
]);
Gettext.bindtextdomain(DOMAIN, directory);

// Shared by Shell, preferences, and standalone GJS modules/tests.
export function _(message) {
  return Gettext.dgettext(DOMAIN, message);
}

// Positional placeholders let translators reorder arguments without translating data.
export function format(message, ...args) {
  let next = 0;
  return message.replace(/%%|%(?:(\d+)\$)?[sd]/g, (token, position) => {
    if (token === '%%') return '%';
    return String(args[position ? Number(position) - 1 : next++]);
  });
}
