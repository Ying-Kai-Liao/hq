#!/bin/sh
# Installs the client-only kith on a Linux VM (a cloud bot's computer) from a GitHub Release. No git, Rust, root or sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/Ying-Kai-Liao/kith/main/scripts/install-guest.sh | sh
#
# Puts one static binary at ~/.local/bin/kith; then `kith join <link>`. Run it again to upgrade. Needs sh, tar and curl (or wget).
# The checksum comes from the same release, so it catches a corrupt or swapped download, not a compromised release.
#
# Environment:
#   KITH_VERSION          a release to install (1.2.3 or v1.2.3); default the latest
#   KITH_GUEST_PREFIX     where to install (bin/kith goes under it); default ~/.local
#   KITH_REPO             GitHub repo to download from; default Ying-Kai-Liao/kith
#   KITH_INSTALL_TARBALL  a local kith-guest-<version>-linux-<arch>.tar.gz to install instead of downloading (tests,
#                         offline); verified against KITH_INSTALL_SHA256 or the .sha256 file beside it, if there is one
set -eu

REPO=${KITH_REPO:-Ying-Kai-Liao/kith}
PREFIX=${KITH_GUEST_PREFIX:-$HOME/.local}

say() { printf '%s\n' "$*"; }
die() { printf 'install-guest: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Linux ] || die "this installs the Linux client; on a Mac use https://raw.githubusercontent.com/$REPO/main/scripts/install.sh"
case $(uname -m) in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
have tar || die "tar is needed"

if have sha256sum; then sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "sha256sum (or shasum) is needed to verify the download"; fi

# fetch <url> <file>: curl, else wget.
if have curl; then fetch() { curl -fsSL -o "$2" "$1"; }
elif have wget; then fetch() { wget -q -O "$2" "$1"; }
else die "curl (or wget) is needed"; fi

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
    if have curl; then
      url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "could not look up the latest release of $REPO"
    else
      url=$(wget -q --max-redirect=0 -S -O /dev/null "https://github.com/$REPO/releases/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tr -d '\r' | head -1) || url=
    fi
    VERSION=${url##*/}
    case $VERSION in v[0-9]*) ;; *) die "could not find the latest release of $REPO (none yet?); set KITH_VERSION" ;; esac
  fi
  VERSION=${VERSION#v}
  ASSET=kith-guest-$VERSION-linux-$ARCH.tar.gz
  BASE=https://github.com/$REPO/releases/download/v$VERSION
  say "downloading kith $VERSION (linux $ARCH)..."
  TARBALL=$WORK/$ASSET
  fetch "$BASE/$ASSET" "$TARBALL" || die "download failed: $BASE/$ASSET"
  fetch "$BASE/SHA256SUMS" "$WORK/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"
  WANT=$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1 }' "$WORK/SHA256SUMS")
  [ -n "$WANT" ] || die "no checksum for $ASSET in SHA256SUMS"
fi

if [ -n "${WANT:-}" ]; then
  [ "$(sha256_of "$TARBALL")" = "$WANT" ] || die "checksum mismatch for $TARBALL; not installing"
  say "checksum ok"
fi

mkdir -p "$WORK/x"
tar -C "$WORK/x" -xzf "$TARBALL"
SRC=$(echo "$WORK"/x/kith-guest-*)
[ -f "$SRC/bin/kith" ] || die "$TARBALL is not a kith client release"

# A new file moved into place by rename, so a running kith is never half-written.
mkdir -p "$PREFIX/bin"
cp "$SRC/bin/kith" "$PREFIX/bin/.kith.new.$$" && chmod 755 "$PREFIX/bin/.kith.new.$$" && mv -f "$PREFIX/bin/.kith.new.$$" "$PREFIX/bin/kith"
say "installed kith to $PREFIX/bin/kith"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) say "add it to your PATH:  export PATH=\"$PREFIX/bin:\$PATH\"" ;;
esac
say "next: kith join <link>"
