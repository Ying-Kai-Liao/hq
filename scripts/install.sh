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

[ "$(uname -s)" = Darwin ] || die "kith's download is for macOS. A Linux VM that only needs the client: curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install-guest.sh | sh. The full kith on Linux: clone https://github.com/$REPO and run ./install.sh"
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
cat > "$WORK/swap.sh" <<'SWAP'
set -eu
cp "$SRC/bin/kith" "$PREFIX/bin/.kith.new.$$" && chmod 755 "$PREFIX/bin/.kith.new.$$" && mv -f "$PREFIX/bin/.kith.new.$$" "$PREFIX/bin/kith"
for part in kernel .claude-plugin install.sh LICENSE LICENSE.serve NOTICE THIRD_PARTY_NOTICES.md README.md; do
  # Tarballs from before LICENSE.serve, NOTICE and THIRD_PARTY_NOTICES.md shipped lack them.
  [ -e "$SRC/share/kith/$part" ] || continue
  rm -rf "$PREFIX/share/kith/$part"
  cp -R "$SRC/share/kith/$part" "$PREFIX/share/kith/$part"
done
SWAP

# The swap runs under the auth.json lock, then waits for every kith-auth / kith_settings process that started
# before it (SIGTERM after KITH_INSTALL_DRAIN_S, default 30; auth.json stays whole, its rename is atomic), then lets
# go. Waiting before the swap would be wrong: an old writer could start in the gap. The old code has no C2 check
# (no grant for someone removed), so no old writer may touch auth.json or settings.json once the new code is in.
cat > "$WORK/quiesce.py" <<'QUIESCE'
import fcntl, os, re, signal, subprocess, sys, time
locks, limit, cmd = sys.argv[1:3], float(sys.argv[3]), sys.argv[4:]
fds = []
for lock in locks:                                  # 1. both locks, always auth then settings (kith_settings writes take the second)
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    fds.append(open(lock, 'a'))
    fcntl.flock(fds[-1], fcntl.LOCK_EX)
if subprocess.call(cmd) != 0:                       # 2. the swap
    sys.exit(1)
t_swap = time.time()
mine = {os.getpid()}
pid = os.getppid()                                  # our own chain is not an old writer
while pid > 1:
    mine.add(pid)
    out = subprocess.run(['ps', '-o', 'ppid=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    pid = int(out) if out.isdigit() else 0
WRITER = re.compile(os.environ.get('KITH_QUIESCE_MATCH') or r'(^|[/\s])(kith-auth|kith_settings(\.py)?)(\s|$)')   # the env is for tests


def seconds(etime):                                 # [[dd-]hh:]mm:ss
    days, _, rest = etime.rpartition('-')
    parts = [int(x) for x in rest.split(':')]
    while len(parts) < 3:
        parts.insert(0, 0)
    return int(days or 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def old_writers():
    out = subprocess.run(['ps', '-axo', 'pid=,etime=,command='], capture_output=True, text=True).stdout
    now, found = time.time(), []
    for line in out.splitlines():
        f = line.split(None, 2)
        if len(f) < 3 or not f[0].isdigit() or int(f[0]) in mine or not WRITER.search(f[2]):
            continue
        try:
            started = now - seconds(f[1])           # etime has whole seconds, so allow one second of slack: a new writer that
                                                    # starts within ~1s after the swap counts as old, is waited for up to the
                                                    # limit and then SIGTERMed. That is the safe side; keep it.
        except ValueError:
            continue
        if started <= t_swap + 1:
            found.append(int(f[0]))
    return found


deadline = time.time() + limit                      # 3. wait for them
while old_writers() and time.time() < deadline:
    time.sleep(0.2)
for p in old_writers():
    try:
        os.kill(p, signal.SIGTERM)
    except OSError:
        pass
for fd in fds:                                      # 4. let go
    fd.close()
QUIESCE
export SRC PREFIX
AUTH_LOCK=${KITH_AUTH:-$PREFIX/secrets/auth.json}.lock
SETTINGS_LOCK=${KITH_SETTINGS_LOCK:-$PREFIX/settings.json.lock}   # next to settings.json, where kith_settings locks
if have python3 && [ -d "$(dirname "$AUTH_LOCK")" ]; then
  python3 "$WORK/quiesce.py" "$AUTH_LOCK" "$SETTINGS_LOCK" "${KITH_INSTALL_DRAIN_S:-30}" sh "$WORK/swap.sh" || die "could not install kith to $PREFIX"
else
  sh "$WORK/swap.sh" || die "could not install kith to $PREFIX"   # a first install: nothing yet to lock
fi
say "installed kith to $PREFIX"

# The rest (~/kith, the commands, the plugin, kith init) is the repo's install.sh, packaged: one place for it.
rm -rf "$WORK"
# `curl | sh` leaves stdin on the script; give setup the terminal back so it can ask its questions.
if [ ! -t 0 ] && [ -z "${KITH_INSTALL_YES:-}" ] && { : </dev/tty; } 2>/dev/null; then exec </dev/tty; fi
exec "$PREFIX/share/kith/install.sh" "$@"
