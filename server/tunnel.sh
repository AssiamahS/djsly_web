#!/usr/bin/env bash
# Keeps a Cloudflare quick tunnel in front of the stem server (:8813) and points the
# djsly-stems Worker relay at it, so the iPhone can reach the Mac from anywhere over HTTPS.
# Quick tunnels expire every few hours ("Tunnel not found"), so this loop probes the relay
# and recreates the tunnel when it dies. Same supervisor pattern as lastlegjet's scripts/tunnel.sh.
set -uo pipefail
PORT="${PORT:-8813}"
KV_ID="${KV_ID:-4bfa5370a5a74f45ac84dd63324b6ebe}"
KV_KEY="${KV_KEY:-upstream}"
RELAY="${RELAY:-https://djsly-stems.sylvesterassiamahpm.workers.dev}"
PROBE_PATH="${PROBE_PATH:-/health}"
LOG="${TUNNEL_LOG:-$HOME/Library/Logs/djsly-stems-tunnel.log}"
PROBE_SECS="${PROBE_SECS:-30}"
MAX_FAILS="${MAX_FAILS:-2}"
RATE_LIMIT_SECS="${RATE_LIMIT_SECS:-600}"
mkdir -p "$(dirname "$LOG")"
CF_PID=""
cleanup() { [ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null; }
trap cleanup EXIT

start_tunnel() {
  : > "$LOG"
  cloudflared tunnel --url "http://localhost:$PORT" --protocol http2 >> "$LOG" 2>&1 &
  CF_PID=$!
  local url=""
  for _ in $(seq 1 40); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "$url" ]; then
    kill "$CF_PID" 2>/dev/null; CF_PID=""
    if grep -q "429 Too Many Requests\|error code: 1015" "$LOG"; then
      echo "$(date -u +%FT%TZ) quick-tunnel API rate limited (429); backing off ${RATE_LIMIT_SECS}s" >&2
      sleep "$RATE_LIMIT_SECS"
    else
      echo "$(date -u +%FT%TZ) tunnel did not come up; see $LOG" >&2
    fi
    return 1
  fi
  echo "$(date -u +%FT%TZ) tunnel: $url"
  if wrangler kv key put --namespace-id "$KV_ID" --remote "$KV_KEY" "$url" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) relay upstream updated -> $RELAY"
  else
    echo "$(date -u +%FT%TZ) WARN: could not update relay KV" >&2
  fi
}
relay_ok() { local code; code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$RELAY$PROBE_PATH" || echo 000); [ "$code" = "200" ]; }

while true; do
  if ! start_tunnel; then sleep 15; continue; fi
  sleep 10
  fails=0
  while kill -0 "$CF_PID" 2>/dev/null; do
    if relay_ok; then fails=0
    else
      fails=$((fails + 1)); echo "$(date -u +%FT%TZ) relay probe failed ($fails/$MAX_FAILS)"
      if [ "$fails" -ge "$MAX_FAILS" ] || grep -q "Tunnel not found" "$LOG"; then
        echo "$(date -u +%FT%TZ) recreating tunnel"; kill "$CF_PID" 2>/dev/null; wait "$CF_PID" 2>/dev/null; CF_PID=""; break
      fi
    fi
    sleep "$PROBE_SECS"
  done
  sleep 2
done
