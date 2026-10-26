import Gettext from 'gettext';
import Gio from 'gi://Gio';

export const DOMAIN = 'clipboard-history-dev';
const directory = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('locale').get_path();
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
