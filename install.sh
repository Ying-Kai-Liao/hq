#!/usr/bin/env bash
# Set up hq on this machine: the hq CLI, plus the Claude Code adapter plugin. Agents are installed separately
# (hq install <github-link>), each its own git repo; the plugin reads them live, so editing one needs no re-install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
mkdir -p "$HOME/.local/bin"
chmod +x "$ROOT/bin/"*
# Everything lives in this folder, each part its own repo the kernel ignores: agents/ (one repo per agent) and
# state/ (memory, data, user.md, projects: your private hq-state repo). $HQ_STATE / $HQ_AGENTS override; an older
# install with ~/.hq keeps it.
if [ -n "${HQ_STATE:-}" ]; then STATE=$HQ_STATE
elif [ -d "$ROOT/state" ] || [ ! -d "$HOME/.hq" ]; then STATE=$ROOT/state
else STATE=$HOME/.hq; fi
if [ -n "${HQ_AGENTS:-}" ]; then AGENTS=$HQ_AGENTS
elif [ "$STATE" = "$ROOT/state" ] || [ -d "$ROOT/agents" ]; then AGENTS=$ROOT/agents
else AGENTS=$STATE/packages; fi
mkdir -p "$STATE/shared/projects" "$AGENTS"
[ -f "$STATE/projects.json" ] || echo '{"projects": {}}' > "$STATE/projects.json"
echo "state folder: $STATE · agents folder: $AGENTS"

# A state folder cloned from another Mac lists its agents in agents.json: install the missing ones (and their
# third-party skills); then fetch anything linked that isn't downloaded yet.
HQ_STATE=$STATE HQ_AGENTS=$AGENTS "$ROOT/bin/hq-pkg" install --saved || echo "note: some agents didn't install; see above"
HQ_STATE=$STATE HQ_AGENTS=$AGENTS "$ROOT/bin/hq-pkg" fetch --all || echo "note: some skills didn't download; each agent retries on its first run"

ln -sfn "$ROOT/bin/hq" "$HOME/.local/bin/hq"
echo "linked hq -> $HOME/.local/bin/hq"

if command -v claude >/dev/null; then
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || true
  claude plugin install hq@hq && echo "installed the hq plugin (restart Claude Code sessions to pick it up)"
fi
[ "$ROOT" = "$HOME/Workspace/hq" ] || echo "note: set the plugin's hq_path to $ROOT in /plugin"
echo "next: hq install <owner>/<repo> for an agent, or hq-new <name> \"<description>\" to start one"
