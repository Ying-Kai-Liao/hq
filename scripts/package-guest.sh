#!/bin/sh
# Packs the static client-only kith (the kith-guest binary) into the Linux release tarball install-guest.sh uses.
#
#   scripts/package-guest.sh <version> <arch> <path-to-kith-guest-binary> [out-dir]
#
# kith-guest-<version>-linux-<arch>.tar.gz holding bin/kith (the binary is built as kith-guest and renamed here) and
# LICENSE, NOTICE, THIRD_PARTY_NOTICES.md. Also writes the tarball's .sha256 next to it, in the "<hash>  <name>" form
# the release's SHA256SUMS concatenates (docs/kith-bot-guests.md section 10.2).
set -eu
[ $# -ge 3 ] || { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
VERSION=${1#v} ARCH=$2 BIN=$3 OUT=${4:-dist}
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
NAME=kith-guest-$VERSION-linux-$ARCH
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/kith-pack.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/bin" "$OUT"
install -m 755 "$BIN" "$STAGE/$NAME/bin/kith"
for f in LICENSE NOTICE THIRD_PARTY_NOTICES.md; do cp "$ROOT/$f" "$STAGE/$NAME/$f"; done
tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
# Linux runners have sha256sum, macOS has shasum.
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
(cd "$OUT" && $SUM "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "$OUT/$NAME.tar.gz"
