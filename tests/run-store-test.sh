#!/usr/bin/env bash
set -euo pipefail
paste_board_test_root=$(mktemp -d /tmp/paste-board-store-test.XXXXXX)
trap 'rm -rf -- "$paste_board_test_root"' EXIT
for paste_board_store_test in store.test.mjs store-input-limits.test.mjs; do
  XDG_CACHE_HOME="$paste_board_test_root" LC_ALL=C.utf8 \
    gjs -m "$(dirname -- "${BASH_SOURCE[0]}")/$paste_board_store_test"
done
