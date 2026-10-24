#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != --session ]]; then
  clipboard_dev_root=$(mktemp -d /tmp/clipboard-dev.XXXXXX)
  clipboard_dev_script=$(readlink -f -- "${BASH_SOURCE[0]}")
  env \
    GSETTINGS_BACKEND=keyfile \
    XDG_CONFIG_HOME="$clipboard_dev_root/config" \
    XDG_CACHE_HOME="$clipboard_dev_root/cache" \
    dbus-run-session -- bash "$clipboard_dev_script" --session \
    2>&1 | tee /tmp/clipboard-dev-shell.log
  exit "${PIPESTATUS[0]}"
fi

# Snap Chromium cannot establish its systemd scope on the isolated session bus.
# Prefer the already installed non-Snap Chrome, keeping the browser isolated.
if command -v google-chrome >/dev/null; then
  clipboard_browser=google-chrome
  clipboard_browser_desktop=google-chrome.desktop
else
  clipboard_browser=chromium
  clipboard_browser_desktop=chromium_chromium.desktop
  command -v chromium >/dev/null
fi
: "${XDG_RUNTIME_DIR:?Wayland runtime directory is required}"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions \
  '["clipboard-history-dev@jidaikobo.shibata"]'
gsettings set org.gnome.shell favorite-apps \
  "[\"org.gnome.TextEditor.desktop\", \"emacs.desktop\", \"$clipboard_browser_desktop\"]"

# The host display remains in the environment for mutter-devkit itself.
# Only Chromium is pointed at the nested compositor's unique socket.
clipboard_dev_display="clipboard-dev-$$"
clipboard_shell_pid=
clipboard_browser_pid=
cleanup() {
  trap - EXIT INT TERM
  if [[ -n $clipboard_browser_pid ]]; then
    kill "$clipboard_browser_pid" 2>/dev/null || true
  fi
  if [[ -n $clipboard_shell_pid ]]; then
    kill "$clipboard_shell_pid" 2>/dev/null || true
    wait "$clipboard_shell_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

gnome-shell --devkit --wayland \
  --wayland-display="$clipboard_dev_display" &
clipboard_shell_pid=$!
for ((attempt=0; attempt<200; attempt++)); do
  if [[ -S "$XDG_RUNTIME_DIR/$clipboard_dev_display" ]]; then
    break
  fi
  if ! kill -0 "$clipboard_shell_pid" 2>/dev/null; then
    echo 'Development Shell exited before its Wayland socket became ready.' >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S "$XDG_RUNTIME_DIR/$clipboard_dev_display" ]]; then
  echo 'Timed out waiting for the development Wayland socket.' >&2
  exit 1
fi

if [[ $clipboard_browser == google-chrome ]]; then
  clipboard_browser_profile=$(mktemp -d /tmp/clipboard-chrome.XXXXXX)
  clipboard_profile_option="--user-data-dir=$clipboard_browser_profile"
else
  clipboard_profile_option=--temp-profile
fi
echo "Starting $clipboard_browser on development display $clipboard_dev_display"
env WAYLAND_DISPLAY="$clipboard_dev_display" \
  "$clipboard_browser" "$clipboard_profile_option" --ozone-platform=wayland \
    --no-first-run --no-default-browser-check about:blank &
clipboard_browser_pid=$!
wait "$clipboard_shell_pid"
