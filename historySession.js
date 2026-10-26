import GLib from 'gi://GLib';

// Metadata only. Clipboard history and paste-set files are managed separately.
export class HistorySession {
  constructor(directory, sessionId, clearOnLogout) {
    if (!sessionId) throw new Error('ログインセッションを識別できません。');
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
      throw new Error('セッション情報の保存先を作成できません。');
    this.path = GLib.build_filenamev([directory, 'history-session.json']);
    let previous = null;
    if (GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
      const [ok, bytes] = GLib.file_get_contents(this.path);
      if (!ok) throw new Error('セッション情報を読み込めません。');
      previous = JSON.parse(new TextDecoder().decode(bytes));
    }
    const changed = !previous || previous.sessionId !== sessionId || previous.ended;
    this.discardHistory = Boolean(previous?.discardPending ||
      (changed && (clearOnLogout || previous?.clearOnLogout)));
    this.state = {sessionId, clearOnLogout, ended: false, discardPending: this.discardHistory};
    this._save();
  }

  _save() {
    if (!GLib.file_set_contents(this.path, JSON.stringify(this.state)))
      throw new Error('セッション情報を保存できません。');
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
