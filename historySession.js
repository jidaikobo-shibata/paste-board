import { _ } from './i18n.js';
import GLib from 'gi://GLib';

// Metadata only. Clipboard history and paste-set files are managed separately.
export class HistorySession {
  constructor(directory, sessionId, clearOnLogout) {
    if (!sessionId) throw new Error(_('Cannot identify the login session.'));
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
      throw new Error(_('Could not create the session metadata directory.'));
    this.path = GLib.build_filenamev([directory, 'history-session.json']);
    let previous = null;
    if (GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
      const [ok, bytes] = GLib.file_get_contents(this.path);
      if (!ok) throw new Error(_('Could not read session metadata.'));
      try {
        if (bytes.length > 65536) throw new Error('Oversized session metadata');
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
        if (!GLib.file_set_contents(this.recoveredFrom, bytes))
          throw new Error(_('Could not save session metadata.'));
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
