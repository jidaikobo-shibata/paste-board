#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != --session ]]; then
  paste_board_dev_root=$(mktemp -d /tmp/paste-board-dev.XXXXXX)
  paste_board_dev_script=$(readlink -f -- "${BASH_SOURCE[0]}")
  env \
    GSETTINGS_BACKEND=keyfile \
    XDG_CONFIG_HOME="$paste_board_dev_root/config" \
    XDG_CACHE_HOME="$paste_board_dev_root/cache" \
    dbus-run-session -- bash "$paste_board_dev_script" --session \
    2>&1 | tee /tmp/paste-board-dev-shell.log
  exit "${PIPESTATUS[0]}"
fi

# Snap Chromium cannot establish its systemd scope on the isolated session bus.
# Prefer the already installed non-Snap Chrome, keeping the browser isolated.
if command -v google-chrome >/dev/null; then
  paste_board_browser=google-chrome
  paste_board_browser_desktop=google-chrome.desktop
else
  paste_board_browser=chromium
  paste_board_browser_desktop=chromium_chromium.desktop
  command -v chromium >/dev/null
fi
: "${XDG_RUNTIME_DIR:?Wayland runtime directory is required}"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions \
  '["paste-board@jidaikobo.shibata"]'
gsettings set org.gnome.shell favorite-apps \
  "[\"org.gnome.TextEditor.desktop\", \"emacs.desktop\", \"$paste_board_browser_desktop\"]"

# The host display remains in the environment for mutter-devkit itself.
# Only Chromium is pointed at the nested compositor's unique socket.
paste_board_dev_display="paste-board-dev-$$"
paste_board_shell_pid=
paste_board_browser_pid=
cleanup() {
  trap - EXIT INT TERM
  if [[ -n $paste_board_browser_pid ]]; then
    kill "$paste_board_browser_pid" 2>/dev/null || true
  fi
  if [[ -n $paste_board_shell_pid ]]; then
    kill "$paste_board_shell_pid" 2>/dev/null || true
    wait "$paste_board_shell_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

gnome-shell --devkit --wayland \
  --wayland-display="$paste_board_dev_display" &
paste_board_shell_pid=$!
for ((attempt=0; attempt<200; attempt++)); do
  if [[ -S "$XDG_RUNTIME_DIR/$paste_board_dev_display" ]]; then
    break
  fi
  if ! kill -0 "$paste_board_shell_pid" 2>/dev/null; then
    echo 'Development Shell exited before its Wayland socket became ready.' >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S "$XDG_RUNTIME_DIR/$paste_board_dev_display" ]]; then
  echo 'Timed out waiting for the development Wayland socket.' >&2
  exit 1
fi

if [[ $paste_board_browser == google-chrome ]]; then
  paste_board_browser_profile=$(mktemp -d /tmp/paste-board-chrome.XXXXXX)
  paste_board_profile_option="--user-data-dir=$paste_board_browser_profile"
else
  paste_board_profile_option=--temp-profile
fi
echo "Starting $paste_board_browser on development display $paste_board_dev_display"
env WAYLAND_DISPLAY="$paste_board_dev_display" \
  "$paste_board_browser" "$paste_board_profile_option" --ozone-platform=wayland \
    --no-first-run --no-default-browser-check about:blank &
paste_board_browser_pid=$!
wait "$paste_board_shell_pid"
