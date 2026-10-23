#!/bin/sh
# Smoke test for an installed or unpacked client-only kith: scripts/smoke-guest.sh <path-to-kith>
# Runs it as a fresh VM would: --version, join --help, and status with no config, which exits 3 (not joined,
# docs/kith-bot-guests.md section 9.4).
set -eu
KITH=${1:?usage: smoke-guest.sh <path-to-kith>}
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kith-smoke.XXXXXX")
trap 'rm -rf "$HOME_DIR"' EXIT
"$KITH" --version
"$KITH" join --help >/dev/null
rc=0
env -u KITH_GUEST_CREDENTIALS KITH_GUEST_HOME="$HOME_DIR" "$KITH" status || rc=$?
[ "$rc" -eq 3 ] || { echo "smoke: kith status with no config exited $rc, want 3" >&2; exit 1; }
echo "smoke ok"
