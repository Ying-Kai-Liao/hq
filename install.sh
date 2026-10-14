#!/usr/bin/env bash
# Set up hq on this machine: the hq CLI, plus the Claude Code adapter plugin. Agents are installed separately
# (hq install <github-link>), each its own git repo; the plugin reads them live, so editing one needs no re-install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
mkdir -p "$HOME/.local/bin"
chmod +x "$ROOT/bin/"*
# Everything lives in this folder, each part its own repo the kernel ignores: agents/ (your agents: each one's
# memory and data, in a private repo of yours, with its role/ as its own repo inside) and state/ (hq's knowledge:
# user.md, projects, agents.json; your private hq-state repo). On a new Mac clone both here first, then run this:
# it installs each agent's role from agents.json.
# ~/.hq is hq's stable address: a link to this folder, so tools and agents never need to know where it really is.
# HQ_HOME points elsewhere instead (lib/hq_paths.py).
if [ -z "${HQ_HOME:-}" ]; then
  if [ ! -e "$HOME/.hq" ]; then ln -s "$ROOT" "$HOME/.hq" && echo "linked ~/.hq -> $ROOT"
  elif [ ! -d "$HOME/.hq/state" ]; then
    echo "install: ~/.hq is an older layout (state directly in it). Move its contents into $ROOT/state, its packages/"
    echo "         into $ROOT/agents, then replace it with a link: ln -sfn \"$ROOT\" ~/.hq" >&2; exit 1
  fi
fi
eval "$(python3 "$ROOT/lib/hq_paths.py" --sh)"
STATE=$HQ_STATE AGENTS=$HQ_AGENTS
mkdir -p "$STATE/shared/projects" "$AGENTS"
[ -f "$STATE/projects.json" ] || echo '{"projects": {}}' > "$STATE/projects.json"
echo "hq home: $HQ_HOME · state: $STATE · agents: $AGENTS"

# A state folder cloned from another Mac lists its agents in agents.json: install the missing ones (and their
# third-party skills); then fetch anything linked that isn't downloaded yet.
"$ROOT/bin/hq-pkg" install --saved || echo "note: some agents didn't install; see above"
"$ROOT/bin/hq-pkg" fetch --all || echo "note: some skills didn't download; each agent retries on its first run"

ln -sfn "$ROOT/bin/hq" "$HOME/.local/bin/hq"
echo "linked hq -> $HOME/.local/bin/hq"

if command -v claude >/dev/null; then
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || true
  claude plugin install hq@hq && echo "installed the hq plugin (restart Claude Code sessions to pick it up)"
fi
[ "$ROOT" = "$HOME/Workspace/hq" ] || echo "note: set the plugin's hq_path to $ROOT in /plugin"
echo "next: hq install <owner>/<repo> for an agent, or hq-new <name> \"<description>\" to start one"
