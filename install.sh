#!/usr/bin/env bash
# Set up hq on this machine: the hq CLI, plus the Claude Code adapter plugin. Agents are installed separately
# (hq install <github-link>), each its own git repo; the plugin reads them live, so editing one needs no re-install.
#
#   git clone https://github.com/Ying-Kai-Liao/hq ~/hq && ~/hq/install.sh
#
# This folder is the hq folder: kernel/ is the code (this repo), and next to it, ignored by this repo, agents/ (your
# agents). ~/.hq is this Mac's hq: hq's knowledge (user.md, projects, agents.json; your hq-state repo) and machine-only
# things (secrets/, job state, logs). On a new Mac clone your agents repo into agents/ and your state repo into ~/.hq
# first, then run this: it installs each agent's role from agents.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
KERNEL=$ROOT/kernel
CUSTOM_HOME=${HQ_HOME:-}   # set by you, before the resolver below fills HQ_HOME in
mkdir -p "$HOME/.local/bin"
chmod +x "$KERNEL/bin/"* "$KERNEL/lib/hq_paths.py"

# ~/hq is hq's stable address, a link to this folder, so tools and agents never need to know where it really is
# (an external disk, a path with spaces). HQ_HOME points elsewhere instead (kernel/lib/hq_paths.py).
if [ -z "$CUSTOM_HOME" ] && [ "$ROOT" != "$HOME/hq" ]; then
  if [ ! -e "$HOME/hq" ]; then ln -s "$ROOT" "$HOME/hq" && echo "linked ~/hq -> $ROOT"
  elif [ "$(cd "$HOME/hq" && pwd -P)" != "$ROOT" ]; then
    echo "install: ~/hq already exists and is not this folder: move it, or set HQ_HOME to use another folder" >&2; exit 1
  fi
fi
# ~/.hq is a real folder on this Mac. Before 2026-10-15 it was a link to the hq folder: that layout keeps working
# (state in <hq>/state, machine things in ~/.config/hq) until it is moved; see docs/architecture.md.
if [ -L "$HOME/.hq" ]; then
  echo "note: ~/.hq is a link (the older layout); hq keeps using <hq>/state and ~/.config/hq until you move them"
else
  mkdir -p "$HOME/.hq/secrets" && chmod 700 "$HOME/.hq/secrets"
  # A git repo of what hq has lived; everything else in ~/.hq stays out of git unless listed here.
  [ -f "$HOME/.hq/.gitignore" ] || cp "$KERNEL/lib/dot-hq.gitignore" "$HOME/.hq/.gitignore"
  [ -d "$HOME/.hq/.git" ] || git -C "$HOME/.hq" init -q
fi
eval "$(python3 "$KERNEL/lib/hq_paths.py" --sh)"
mkdir -p "$HQ_STATE/projects" "$HQ_AGENTS"
[ -f "$HQ_STATE/projects.json" ] || echo '{"projects": {}}' > "$HQ_STATE/projects.json"
echo "hq home: $HQ_HOME · state: $HQ_STATE · agents: $HQ_AGENTS"

# A state folder cloned from another Mac lists its agents in agents.json: install the missing ones (and their
# third-party skills); then fetch anything linked that isn't downloaded yet.
"$KERNEL/bin/hq-pkg" install --saved || echo "note: some agents didn't install; see above"
"$KERNEL/bin/hq-pkg" fetch --all || echo "note: some skills didn't download; each agent retries on its first run"

# Through ~/hq: the path agents see then has no volume name (and no spaces) in it.
BIN=$KERNEL/bin/hq; [ -z "$CUSTOM_HOME" ] && BIN=$HOME/hq/kernel/bin/hq
ln -sfn "$BIN" "$HOME/.local/bin/hq"
echo "linked $HOME/.local/bin/hq -> $BIN"

if command -v claude >/dev/null; then
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || true
  claude plugin install hq@hq && echo "installed the hq plugin (restart Claude Code sessions to pick it up)"
  [ -z "$CUSTOM_HOME" ] || echo "note: set the plugin's hq_path to $KERNEL in /plugin"
fi
echo "next: hq new <name> \"<description>\" to start an agent, or hq install <owner>/<repo> for one someone shared"
