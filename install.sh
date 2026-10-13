#!/usr/bin/env bash
# Set up hq on this machine: the hq CLI, plus the Claude Code adapter plugin.
# The plugin reads agents/ live, so editing an agent.md or PROTOCOL.md needs no re-install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
mkdir -p "$HOME/.local/bin"
chmod +x "$ROOT/bin/"*
# State (memory, data, learned skills, user.md, projects) lives outside the repo: $HQ_STATE, default ~/.hq.
STATE=${HQ_STATE:-$HOME/.hq}
mkdir -p "$STATE/shared/projects"
[ -f "$STATE/projects.json" ] || echo '{"projects": {}}' > "$STATE/projects.json"
for a in "$ROOT"/agents/*/; do n=$(basename "$a"); mkdir -p "$STATE/agents/$n/memory/projects" "$STATE/agents/$n/memory/sessions" "$STATE/agents/$n/skills/learned"; done
echo "state folder: $STATE"

# Third-party skills are linked in each agent's skills.json, not copied: download them now (a run would on first use).
"$ROOT/bin/hq-pkg" fetch --all || echo "note: some skills didn't download; each agent retries on its first run"

ln -sfn "$ROOT/bin/hq" "$HOME/.local/bin/hq"
echo "linked hq -> $HOME/.local/bin/hq"

if command -v claude >/dev/null; then
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || true
  claude plugin install hq@hq && echo "installed the hq plugin (restart Claude Code sessions to pick it up)"
fi
[ "$ROOT" = "$HOME/Workspace/hq" ] || echo "note: set the plugin's hq_path to $ROOT in /plugin"
