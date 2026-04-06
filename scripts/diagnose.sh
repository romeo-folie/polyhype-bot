#!/bin/bash
# diagnose.sh — On-demand PGA health summary.
# Usage: bash scripts/diagnose.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$HOME/logs/pga"

echo "=== PGA DIAGNOSTICS ($(date -Iseconds)) ==="
echo ""

# --- SYSTEM ---
echo "--- SYSTEM ---"
echo "• Uptime: $(uptime -p)"
echo "• Disk: $(df -h / | awk 'NR==2{print $3 " used / " $2 " total (" $5 " full)"}')"
echo ""
echo "• Containers:"
(cd "$PROJECT_DIR" && docker compose ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null) || echo "  (docker compose not available)"
echo ""

# --- REDIS ---
echo "--- REDIS ---"
if command -v redis-cli >/dev/null 2>&1; then
  locks=$(redis-cli KEYS '*lock*' 2>/dev/null)
  if [[ -z "$locks" ]]; then
    echo "• Locks: none"
  else
    echo "• Locks:"
    echo "$locks" | sed 's/^/    /'
  fi

  cal_enabled=$(redis-cli GET calibration:enabled 2>/dev/null)
  echo "• Calibration enabled: ${cal_enabled:-not set}"

  echo "• Outcome counts by category:"
  for key in $(redis-cli KEYS 'outcomes:*' 2>/dev/null); do
    count=$(redis-cli ZCARD "$key" 2>/dev/null)
    echo "    $key: $count"
  done

  rc_size=$(redis-cli SCARD 'redeemer:recently-closed' 2>/dev/null)
  echo "• redeemer:recently-closed size: ${rc_size:-0}"
else
  echo "  (redis-cli not available)"
fi
echo ""

# --- ERRORS (last 24h) ---
echo "--- ERRORS (last 24h) ---"
cutoff=$(date -d '24 hours ago' +%Y-%m-%dT%H:%M 2>/dev/null || date -v-24H +%Y-%m-%dT%H:%M 2>/dev/null || echo "")
if [[ -d "$LOG_DIR" ]]; then
  for logfile in "$LOG_DIR"/*.log; do
    [[ -f "$logfile" ]] || continue
    name=$(basename "$logfile")
    [[ "$name" == "rotation.log" ]] && continue
    err_count=$(grep -c '"level":"error"' "$logfile" 2>/dev/null || true)
    err_count=${err_count:-0}
    warn_count=$(grep -c '"level":"warn"' "$logfile" 2>/dev/null || true)
    warn_count=${warn_count:-0}
    echo "• $name — errors: $err_count, warns: $warn_count"
    if (( err_count > 0 )); then
      echo "  Last 5 errors:"
      grep '"level":"error"' "$logfile" 2>/dev/null | tail -5 | while IFS= read -r line; do
        msg=$(echo "$line" | grep -oP '"msg":"[^"]*"' | head -1)
        echo "    ${msg:-$line}" | cut -c1-120
      done
    fi
  done

  # Also check docker worker logs
  echo ""
  echo "• Docker worker errors (last 24h):"
  for svc in pga-spot-feed pga-arb pga-copytrade pga-futures pga-telegram; do
    err_count=$(cd "$PROJECT_DIR" && docker compose logs --since 24h "$svc" 2>/dev/null | grep -c '"level":"error"' || true)
    err_count=${err_count:-0}
    if (( err_count > 0 )); then
      echo "  $svc: $err_count errors"
      (cd "$PROJECT_DIR" && docker compose logs --since 24h "$svc" 2>/dev/null) | grep '"level":"error"' | tail -3 | while IFS= read -r line; do
        msg=$(echo "$line" | grep -oP '"msg":"[^"]*"' | head -1)
        echo "    ${msg:-$line}" | cut -c1-120
      done
    else
      echo "  $svc: 0 errors"
    fi
  done
else
  echo "  (log directory $LOG_DIR not found)"
fi
echo ""

# --- TRADES (last 24h) ---
echo "--- TRADES (last 24h) ---"
trade_log="$LOG_DIR/trade.log"
if [[ -f "$trade_log" ]]; then
  executed=$(grep -c 'trade-executed\|notifyTradeExecuted' "$trade_log" 2>/dev/null || true)
  executed=${executed:-0}
  echo "• Executed trades: $executed"
  last_trade=$(grep 'trade-executed\|notifyTradeExecuted' "$trade_log" 2>/dev/null | tail -1)
  if [[ -n "$last_trade" ]]; then
    echo "• Last trade: $(echo "$last_trade" | cut -c1-150)"
  fi
  skipped=$(grep -c 'SKIP\|skip\|blocked\|BLOCKED' "$trade_log" 2>/dev/null || true)
  skipped=${skipped:-0}
  echo "• Skipped/blocked: $skipped"
else
  echo "  (no trade log found)"
fi
echo ""

# --- POSITIONS ---
echo "--- POSITIONS ---"
if command -v redis-cli >/dev/null 2>&1; then
  pos_count=$(redis-cli HLEN 'positions:active' 2>/dev/null || echo "?")
  echo "• Active positions: $pos_count"

  bankroll=$(redis-cli GET 'bankroll:current' 2>/dev/null)
  echo "• Current bankroll: ${bankroll:-not set}"
fi
echo ""

# --- SPOT FEEDS ---
echo "--- SPOT FEEDS ---"
spot_status=$(cd "$PROJECT_DIR" && docker compose logs --since 1h pga-spot-feed 2>/dev/null | grep -i 'subscribed\|connected\|symbols' | tail -3)
if [[ -n "$spot_status" ]]; then
  echo "$spot_status" | sed 's/^/• /'
else
  echo "• (no recent spot-feed activity found)"
fi
last_tick=$(cd "$PROJECT_DIR" && docker compose logs --since 5m pga-spot-feed 2>/dev/null | tail -1)
if [[ -n "$last_tick" ]]; then
  echo "• Last activity: $(echo "$last_tick" | cut -c1-120)"
else
  echo "• Last activity: (no ticks in last 5 min — feed may be down)"
fi
echo ""
echo "=== END DIAGNOSTICS ==="
