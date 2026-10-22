#!/bin/sh
# Installs kith from a GitHub Release, no git or Rust needed:
#
#   curl -fsSL https://raw.githubusercontent.com/Ying-Kai-Liao/kith/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --from <your-github-user>     a new Mac: brings your state and agents back
#
# Puts bin/kith and share/kith/ (the kernel, the Claude Code plugin) under ~/.kith, then runs the packaged
# install.sh: ~/kith, the kith and hq (its old name) commands in ~/.local/bin, the plugin, `kith init`. Run it again to upgrade; your
# agents (~/kith/agents) and state (~/.kith, or ~/.hq until kith migrate) are never touched. Arguments go to `kith init`.
#
# Environment:
#   KITH_VERSION          a release to install (1.2.3 or v1.2.3); default the latest
#   KITH_PREFIX           where to install; default ~/.kith
#   KITH_INSTALL_YES      never reconnect setup to the terminal (unattended; its offers are skipped)
#   KITH_REPO             GitHub repo to download from; default Ying-Kai-Liao/kith
#   KITH_INSTALL_TARBALL  a local kith-<version>-darwin-<arch>.tar.gz to install instead of downloading (tests,
#                         offline); verified against KITH_INSTALL_SHA256 or the .sha256 file beside it, if there is one
set -eu

REPO=${KITH_REPO:-Ying-Kai-Liao/kith}
PREFIX=${KITH_PREFIX:-$HOME/.kith}

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Darwin ] || die "kith's download is for macOS; on Linux clone https://github.com/$REPO and run ./install.sh"
case $(uname -m) in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64) ARCH=x86_64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
have curl || die "curl is needed"
have tar || die "tar is needed"

sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kith-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

if [ -n "${KITH_INSTALL_TARBALL:-}" ]; then
  TARBALL=$KITH_INSTALL_TARBALL
  [ -f "$TARBALL" ] || die "$TARBALL not found"
  WANT=${KITH_INSTALL_SHA256:-}
  [ -n "$WANT" ] || { [ -f "$TARBALL.sha256" ] && WANT=$(cut -d' ' -f1 < "$TARBALL.sha256"); } || true
else
  VERSION=${KITH_VERSION:-}
  if [ -z "$VERSION" ]; then
    # /releases/latest redirects to /releases/tag/vX.Y.Z.
    url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "could not look up the latest release of $REPO"
    VERSION=${url##*/}
    case $VERSION in v[0-9]*) ;; *) die "$REPO has no release yet" ;; esac
  fi
  VERSION=${VERSION#v}
  ASSET=kith-$VERSION-darwin-$ARCH.tar.gz
  BASE=https://github.com/$REPO/releases/download/v$VERSION
  say "downloading kith $VERSION ($ARCH)..."
  TARBALL=$WORK/$ASSET
  curl -fSL --progress-bar -o "$TARBALL" "$BASE/$ASSET" || die "download failed: $BASE/$ASSET"
  curl -fsSL -o "$WORK/SHA256SUMS" "$BASE/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"
  WANT=$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1 }' "$WORK/SHA256SUMS")
  [ -n "$WANT" ] || die "no checksum for $ASSET in SHA256SUMS"
fi

if [ -n "${WANT:-}" ]; then
  [ "$(sha256_of "$TARBALL")" = "$WANT" ] || die "checksum mismatch for $TARBALL; not installing"
  say "checksum ok"
fi

mkdir -p "$WORK/x"
tar -C "$WORK/x" -xzf "$TARBALL"
SRC=$(echo "$WORK"/x/kith-*)
[ -x "$SRC/bin/kith" ] && [ -d "$SRC/share/kith/kernel" ] || die "$TARBALL is not a kith release"

# Swap in what a release owns; anything else under share/kith (agents/, state of an older layout) stays.
# A new file is moved into place by rename, so a running kith is never half-written.
mkdir -p "$PREFIX/bin" "$PREFIX/share/kith"
cp "$SRC/bin/kith" "$PREFIX/bin/.kith.new.$$" && chmod 755 "$PREFIX/bin/.kith.new.$$" && mv -f "$PREFIX/bin/.kith.new.$$" "$PREFIX/bin/kith"
for part in kernel .claude-plugin install.sh LICENSE LICENSE.serve NOTICE README.md; do
  rm -rf "$PREFIX/share/kith/$part"
  cp -R "$SRC/share/kith/$part" "$PREFIX/share/kith/$part"
done
say "installed kith to $PREFIX"

# The rest (~/kith, the commands, the plugin, kith init) is the repo's install.sh, packaged: one place for it.
rm -rf "$WORK"
# `curl | sh` leaves stdin on the script; give setup the terminal back so it can ask its questions.
if [ ! -t 0 ] && [ -z "${KITH_INSTALL_YES:-}" ] && { : </dev/tty; } 2>/dev/null; then exec </dev/tty; fi
exec "$PREFIX/share/kith/install.sh" "$@"
