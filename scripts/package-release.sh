#!/bin/sh
# Packs a built kith binary and the kernel into the release tarball the installer and the Homebrew formula use.
#
#   scripts/package-release.sh <version> <arch> <path-to-kith-binary> [out-dir]
#
# kith-<version>-darwin-<arch>.tar.gz holding bin/kith and share/kith/{kernel,.claude-plugin,install.sh,LICENSE,
# README.md}: the layout the binary's kernel lookup expects (kernel at ../share/kith/kernel). Also writes the
# tarball's .sha256 next to it.
set -eu
[ $# -ge 3 ] || { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
VERSION=${1#v} ARCH=$2 BIN=$3 OUT=${4:-dist}
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
NAME=kith-$VERSION-darwin-$ARCH
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/kith-pack.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/bin" "$STAGE/$NAME/share/kith" "$OUT"
install -m 755 "$BIN" "$STAGE/$NAME/bin/kith"
S=$STAGE/$NAME/share/kith
cp -R "$ROOT/kernel" "$S/kernel"
cp -R "$ROOT/.claude-plugin" "$S/.claude-plugin"
cp "$ROOT/install.sh" "$ROOT/LICENSE" "$ROOT/README.md" "$S/"
# Tests and caches are for the repo, not the install.
rm -rf "$S/kernel/tests"
find "$S" \( -name __pycache__ -o -name .DS_Store \) -prune -exec rm -rf {} +
tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "$OUT/$NAME.tar.gz"
