#!/usr/bin/env bash
# Set up hq on this machine: the hq CLI, plus the Claude Code adapter plugin. Agents are installed separately
# (hq install <github-link>), each its own git repo; the plugin reads them live, so editing one needs no re-install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
mkdir -p "$HOME/.local/bin"
chmod +x "$ROOT/bin/"*
# State (memory, data, user.md, projects) lives outside the repo: $HQ_STATE, default ~/.hq. Agents live in its
# packages/ folder ($HQ_AGENTS).
STATE=${HQ_STATE:-$HOME/.hq}
mkdir -p "$STATE/shared/projects" "${HQ_AGENTS:-$STATE/packages}"
[ -f "$STATE/projects.json" ] || echo '{"projects": {}}' > "$STATE/projects.json"
echo "state folder: $STATE"

# A state folder cloned from another Mac lists its agents in agents.json: install the missing ones (and their
# third-party skills); then fetch anything linked that isn't downloaded yet.
HQ_STATE=$STATE "$ROOT/bin/hq-pkg" install --saved || echo "note: some agents didn't install; see above"
HQ_STATE=$STATE "$ROOT/bin/hq-pkg" fetch --all || echo "note: some skills didn't download; each agent retries on its first run"

ln -sfn "$ROOT/bin/hq" "$HOME/.local/bin/hq"
echo "linked hq -> $HOME/.local/bin/hq"

if command -v claude >/dev/null; then
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || true
  claude plugin install hq@hq && echo "installed the hq plugin (restart Claude Code sessions to pick it up)"
fi
[ "$ROOT" = "$HOME/Workspace/hq" ] || echo "note: set the plugin's hq_path to $ROOT in /plugin"
echo "next: hq install <owner>/<repo> for an agent, or hq-new <name> \"<description>\" to start one"
