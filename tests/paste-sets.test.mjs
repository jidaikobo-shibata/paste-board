import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { flushSets } from './flush-paste-sets.js';
import { PasteSets } from '../pasteSets.js';

// Exercise the actual UI callback against the real validator and file writer.
const file = Gio.File.new_for_uri(import.meta.url)
  .get_parent()
  .get_parent()
  .get_child('extension.js');
const source = new TextDecoder().decode(
  GLib.file_get_contents(file.get_path())[1],
);
const start = source.indexOf('  _editPasteSetName(');
const end = source.indexOf('\n  _editPasteSetItem(', start);
const _ = (value) => value;
let save;
class PasteSetDialog {
  constructor(title, name, text, callback) {
    save = callback;
  }
}
const Owner = eval('(class {' + source.slice(start, end) + '})');
const directory = GLib.dir_make_tmp('paste-board-set-test.XXXXXX');
let checks = 0;
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  checks++;
}
try {
  const owner = new Owner();
  owner._pasteSets = new PasteSets(directory);
  owner._openPasteSetDialog = () => {};
  owner._renderPasteSets = () => {};
  owner._editPasteSetName(null, 'first\ntext\n');
  save('First set');
  flushSets(owner._pasteSets);
  let loaded = new PasteSets(directory);
  equal(loaded.data.sets.length, 1);
  equal(loaded.data.sets[0].name, 'First set');
  equal(loaded.data.sets[0].items[0].kind, 'text');
  equal(loaded.data.sets[0].items[0].text, 'first\ntext\n');
  equal(owner._activePasteTab, loaded.data.sets[0].id);
  owner._editPasteSetName();
  save('Empty set');
  flushSets(owner._pasteSets);
  loaded = new PasteSets(directory);
  equal(loaded.data.sets[1].items, []);
  owner._editPasteSetName(loaded.data.sets[0].id);
  save('Renamed');
  flushSets(owner._pasteSets);
  equal(new PasteSets(directory).data.sets[0].name, 'Renamed');
} finally {
  GLib.unlink(directory + '/paste-sets.json');
  GLib.rmdir(directory);
}
print(`Paste-set UI and persistence: ${checks} checks passed`);
