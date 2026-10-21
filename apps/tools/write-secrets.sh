#!/bin/sh
# Writes the gitignored apps/shared/Config/Secrets.plist from the PostHog key kept outside the
# repo (default ~/.hq/secrets/posthog-key, one line). Never prints the key.
set -eu
src="${1:-$HOME/.hq/secrets/posthog-key}"
out="$(cd "$(dirname "$0")/.." && pwd)/shared/Config/Secrets.plist"
[ -s "$src" ] || { rm -f "$out"; echo "no key file at $src; the built-in key is used" >&2; exit 0; }
key="$(head -n 1 "$src" | tr -d '[:space:]')"
[ -n "$key" ] || { rm -f "$out"; echo "key file is empty; the built-in key is used" >&2; exit 0; }
umask 077
cat > "$out" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>POSTHOG_API_KEY</key>
	<string>$key</string>
</dict>
</plist>
PLIST
echo "wrote $out"
