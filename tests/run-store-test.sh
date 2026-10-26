#!/usr/bin/env bash
set -euo pipefail
paste_board_test_root=$(mktemp -d /tmp/paste-board-store-test.XXXXXX)
trap 'rm -rf -- "$paste_board_test_root"' EXIT
XDG_CACHE_HOME="$paste_board_test_root" LC_ALL=C.utf8 \
  gjs -m "$(dirname -- "${BASH_SOURCE[0]}")/store.test.mjs"
