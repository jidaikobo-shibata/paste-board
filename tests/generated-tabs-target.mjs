import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
const app = new Gtk.Application({
  application_id: 'org.pasteboard.GeneratedTabTest',
});
app.connect('activate', () => {
  const view = new Gtk.TextView();
  const window = new Gtk.ApplicationWindow({
    application: app,
    title: 'Generated tab paste target',
    default_width: 500,
    default_height: 200,
    child: view,
  });
  view.buffer.connect('changed', () =>
    GLib.file_set_contents(
      `${GLib.get_user_cache_dir()}/generated-pasted`,
      view.buffer.text,
    ),
  );
  GLib.file_set_contents(`${GLib.get_user_cache_dir()}/generated-pasted`, '');
  window.present();
  view.grab_focus();
});
app.run([]);
