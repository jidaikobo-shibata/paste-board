#!/usr/bin/env bash
set -euo pipefail

# Everything, including the runtime socket and D-Bus session, is disposable.
# This never sends input to the user's desktop or modifies its settings.
if [[ ${1:-} != --session ]]; then
  editor_test_repo=$(cd "$(dirname "$0")/.." && pwd)
  editor_test_root=$(mktemp -d /tmp/paste-board-editor-test.XXXXXX)
  export GSETTINGS_BACKEND=keyfile GIO_USE_VFS=local
  export LC_ALL="${EDITOR_TEST_LOCALE:-C.utf8}"
  export XDG_CONFIG_HOME="$editor_test_root/config"
  export XDG_CACHE_HOME="$editor_test_root/cache"
  export XDG_DATA_HOME="$editor_test_root/data"
  export XDG_RUNTIME_DIR="$editor_test_root/runtime"
  unset DISPLAY WAYLAND_DISPLAY XDG_SESSION_ID
  mkdir -m700 -p "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" \
    "$XDG_DATA_HOME/gnome-shell/extensions/editor-test@local"
  ln -s "$editor_test_repo" \
    "$XDG_DATA_HOME/gnome-shell/extensions/paste-board@jidaikobo.shibata"
  cp "$editor_test_repo/tests/editor-ui.test.js" \
    "$XDG_DATA_HOME/gnome-shell/extensions/editor-test@local/extension.js"
  cat > "$XDG_DATA_HOME/gnome-shell/extensions/editor-test@local/metadata.json" <<'JSON'
{"uuid":"editor-test@local","name":"Editor UI test","description":"Isolated test","shell-version":["50"]}
JSON
  printf 'Editor test files: %s\n' "$editor_test_root"
  exec timeout 45s dbus-run-session -- bash "$0" --session
fi

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions \
  '["paste-board@jidaikobo.shibata","editor-test@local"]'
gnome-shell --headless --wayland --no-x11 --virtual-monitor=1280x800 \
  --wayland-display="paste-board-editor-test-$$" \
  > "$XDG_CACHE_HOME/shell.log" 2>&1 &
editor_test_pid=$!
trap 'kill "$editor_test_pid" 2>/dev/null || true; wait "$editor_test_pid" 2>/dev/null || true' EXIT
for ((attempt=0; attempt<350; attempt++)); do
  if [[ -f "$XDG_CACHE_HOME/result" ]]; then
    if [[ $(cat "$XDG_CACHE_HOME/result") == PASS ]]; then
      echo 'Editor UI: PASS'
      exit 0
    fi
    tail -n 60 "$XDG_CACHE_HOME/shell.log"
    exit 1
  fi
  sleep 0.1
done
tail -n 60 "$XDG_CACHE_HOME/shell.log"
exit 1
