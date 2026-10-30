import GLib from 'gi://GLib';

// Let synchronous UI/localization fixtures observe completed asynchronous I/O.
export function flushSets(store) {
  const loop = GLib.MainLoop.new(null, false);
  let failure;
  store
    .flush()
    .catch((error) => {
      failure = error;
    })
    .finally(() => loop.quit());
  loop.run();
  if (failure) throw failure;
}
