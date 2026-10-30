import { _ } from './i18n.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readBoundedFile } from './inputLimits.js';

// Metadata only. Clipboard history and paste-set files are managed separately.
export class HistorySession {
  constructor(directory, sessionId, clearOnLogout) {
    if (!sessionId) throw new Error(_('Cannot identify the login session.'));
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
      throw new Error(_('Could not create the session metadata directory.'));
    this.path = GLib.build_filenamev([directory, 'history-session.json']);
    let previous = null;
    if (GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
      try {
        const bytes = readBoundedFile(this.path, 65536);
        previous = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        if (
          !previous ||
          typeof previous.sessionId !== 'string' ||
          !previous.sessionId ||
          ['clearOnLogout', 'ended', 'discardPending'].some(
            (key) => typeof previous[key] !== 'boolean',
          )
        )
          throw new Error('Invalid session metadata');
      } catch {
        // Unknown session identity must honor the current cleanup policy. Keep
        // the malformed metadata before replacing it; it contains no history.
        this.recoveredFrom =
          this.path + '.invalid-' + GLib.uuid_string_random();
        Gio.File.new_for_path(this.path).move(
          Gio.File.new_for_path(this.recoveredFrom),
          Gio.FileCopyFlags.NONE,
          null,
          null,
        );
        previous = null;
      }
    }
    const changed =
      !previous || previous.sessionId !== sessionId || previous.ended;
    this.discardHistory = Boolean(
      previous?.discardPending ||
        (changed && (clearOnLogout || previous?.clearOnLogout)),
    );
    this.state = {
      sessionId,
      clearOnLogout,
      ended: false,
      discardPending: this.discardHistory,
    };
    this._save();
  }

  _save() {
    if (!GLib.file_set_contents(this.path, JSON.stringify(this.state)))
      throw new Error(_('Could not save session metadata.'));
  }

  setEnabled(enabled) {
    this.state.clearOnLogout = enabled;
    this._save();
  }

  end() {
    this.state.ended = true;
    this.state.discardPending = this.state.clearOnLogout;
    this._save();
  }

  cleared() {
    this.state.discardPending = false;
    this._save();
  }
}
