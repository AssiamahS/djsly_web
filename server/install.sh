#!/usr/bin/env bash
# Installs the djsly stem server as a launchd agent (starts at login, restarts if it dies). Port 8813.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.djsly.stems.plist"
mkdir -p "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.djsly.stems</string>
  <key>ProgramArguments</key><array><string>$HERE/stems_server.py</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/djsly-stems.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/djsly-stems.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.djsly.stems" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
curl -s http://127.0.0.1:8813/health && echo && echo "installed → log: ~/Library/Logs/djsly-stems.log"

# --- public HTTPS relay for the iPhone (Cloudflare quick tunnel → djsly-stems Worker) ---
if command -v cloudflared >/dev/null && command -v wrangler >/dev/null; then
  TPLIST="$HOME/Library/LaunchAgents/com.djsly.stems-tunnel.plist"
  cat > "$TPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.djsly.stems-tunnel</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/tunnel.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/djsly-stems-tunnel.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/djsly-stems-tunnel.out.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/com.djsly.stems-tunnel" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$TPLIST"
  echo "tunnel agent installed → relay https://djsly-stems.sylvesterassiamahpm.workers.dev (log: ~/Library/Logs/djsly-stems-tunnel.out.log)"
else
  echo "cloudflared/wrangler missing — iPhone access limited to the same Wi-Fi (http://<mac-ip>:8813/)"
fi
