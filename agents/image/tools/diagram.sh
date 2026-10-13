#!/bin/sh
# diagram.sh IN.mmd OUT.png [WIDTH]  — Mermaid → PNG in the house style (mermaid-cli, 3x for crisp text).
# Never overwrites: an existing OUT becomes OUT-v2.png. Also writes OUT.svg for editing or the web.
set -e
in=$1; out=$2; width=${3:-1600}
[ -f "$in" ] && [ -n "$out" ] || { echo '{"ok": false, "error": "usage: diagram.sh IN.mmd OUT.png [WIDTH]"}'; exit 1; }
command -v mmdc >/dev/null || { echo '{"ok": false, "error": "mmdc not found: npm i -g @mermaid-js/mermaid-cli"}'; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
base=${out%.png}; n=2; while [ -e "$base.png" ]; do base="${out%.png}-v$n"; n=$((n+1)); done
mkdir -p "$(dirname "$base")"
mmdc -q -i "$in" -o "$base.png" -c "$here/themes/mermaid-hq.json" -b '#efede6' -w "$width" -s 3 >/dev/null 2>&1 \
  || { echo "{\"ok\": false, \"error\": \"mermaid failed; check the syntax in $in\"}"; exit 1; }
mmdc -q -i "$in" -o "$base.svg" -c "$here/themes/mermaid-hq.json" -b '#efede6' >/dev/null 2>&1 || true
echo "{\"ok\": true, \"file\": \"$base.png\", \"svg\": \"$base.svg\"}"
