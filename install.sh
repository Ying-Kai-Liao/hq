#!/usr/bin/env bash
# Set up hq on this Mac: the hq command, the Claude Code plugin, then `hq init` (your folders, backups, a starter
# agent). Safe to run again.
#
#   git clone https://github.com/Ying-Kai-Liao/hq ~/hq && ~/hq/install.sh
#   ~/hq/install.sh --from <your-github-user>      a new Mac: brings back your state and agents
#
# This folder is the hq folder: kernel/ is the code (this repo), and next to it, ignored by this repo, agents/ (your
# agents, their own private repo). ~/.hq is this Mac's hq: hq's knowledge (user.md, projects, agents.json; your
# hq-state repo) and machine-only things (secrets/, job state, logs). See docs/architecture.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
KERNEL=$ROOT/kernel
CUSTOM_HOME=${HQ_HOME:-}   # set by you, before the resolver below fills HQ_HOME in
mkdir -p "$HOME/.local/bin"
chmod +x "$KERNEL/bin/"* "$KERNEL/lib/hq_paths.py"

# ~/hq is hq's stable address, a link to this folder, so tools and agents never need to know where it really is
# (an external disk, a path with spaces). HQ_HOME points elsewhere instead (kernel/lib/hq_paths.py).
if [ -z "$CUSTOM_HOME" ] && [ "$ROOT" != "$HOME/hq" ]; then
  if [ ! -e "$HOME/hq" ]; then ln -s "$ROOT" "$HOME/hq"
  elif [ "$(cd "$HOME/hq" && pwd -P)" != "$ROOT" ]; then
    echo "install: ~/hq already exists and is not this folder: move it, or set HQ_HOME to use another folder" >&2; exit 1
  fi
fi
# ~/.hq is a real folder on this Mac (hq init fills it). Before 2026-10-15 it was a link to the hq folder: that layout
# keeps working (state in <hq>/state, machine things in ~/.config/hq) until it is moved; see docs/architecture.md.
if [ -L "$HOME/.hq" ]; then
  echo "note: ~/.hq is a link (the older layout); hq keeps using <hq>/state and ~/.config/hq until you move them"
else
  mkdir -p "$HOME/.hq/secrets" && chmod 700 "$HOME/.hq/secrets"
fi

# Through ~/hq: the path agents see then has no volume name (and no spaces) in it.
BIN=$KERNEL/bin/hq; [ -z "$CUSTOM_HOME" ] && BIN=$HOME/hq/kernel/bin/hq
ln -sfn "$BIN" "$HOME/.local/bin/hq"
# kith: the same command under its new name (kith serve ...); the kernel itself is renamed later.
ln -sfn "${BIN%/hq}/kith" "$HOME/.local/bin/kith"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "note: add ~/.local/bin to your PATH to use hq (e.g. in ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;; esac

if command -v claude >/dev/null; then
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || true
  claude plugin install hq@hq >/dev/null 2>&1 || echo "note: the Claude Code plugin did not install: claude plugin install hq@hq"
  [ -z "$CUSTOM_HOME" ] || echo "note: set the plugin's hq_path to $KERNEL in /plugin"
fi

# Kith's host is optional and takes minutes to build, so it is never built here.
if command -v cargo >/dev/null || ls "$HOME"/.rustup/toolchains/*/bin/cargo >/dev/null 2>&1; then
  echo "note: kith serve start builds and runs Kith's host on this Mac (a few minutes the first time)"
fi

# Your folders, backups and a first agent; --from <user> brings back yours from GitHub.
exec "$KERNEL/bin/hq-init" "$@"
