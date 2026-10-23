#!/bin/bash
# Markdown for a job summary: each screenshot next to the mock it should match (docs/design/mocks/).
# Usage: scripts/screens-summary.sh <ios|desktop> <screens-dir>
set -euo pipefail
platform="${1:?ios|desktop}"
dir="${2:?screens dir}"

# Screenshot name prefix -> mock. No mock yet: "none".
mock_for() {
  case "$1" in
    *demo-crew*) echo "docs/design/mocks/home-v5.png" ;;
    *demo-settings*) echo "docs/design/mocks/profile.png" ;;
    *demo-widgets*) echo "none" ;;
    *tokens*) echo "docs/design/mocks/system.png" ;;
    *components-thread*) echo "docs/design/mocks/threads2.png" ;;
    *components*) echo "docs/design/mocks/system.png" ;;
    *) echo "none" ;;
  esac
}

echo "## Screens ($platform)"
echo
echo "| Screenshot | Mock |"
echo "| --- | --- |"
shopt -s nullglob
for f in "$dir"/*.png; do
  base=$(basename "$f")
  echo "| \`$base\` | \`$(mock_for "$base")\` |"
done
echo
echo "Download the \`screens-$platform\` artifact from this run."
