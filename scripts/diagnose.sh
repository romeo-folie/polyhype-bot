#!/bin/bash
# diagnose.sh — On-demand PGA health summary.
# Usage: bash scripts/diagnose.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$HOME/logs/pga"

echo "=== PGA DIAGNOSTICS ($(date -Iseconds)) ==="
echo ""

# Redis runs inside docker-compose on Hetzner — no host-level redis-cli.
# Wrap every redis-cli call so the same code path works whether redis-cli
# is installed on the host or only inside the container.
redis_q() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli "$@" 2>/dev/null
  else
    (cd "$PROJECT_DIR" && docker compose exec -T redis redis-cli "$@" 2>/dev/null)
  fi
}
redis_available() {
  command -v redis-cli >/dev/null 2>&1 || \
    (cd "$PROJECT_DIR" && docker compose ps redis 2>/dev/null | grep -q 'Up')
}

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
if redis_available; then
  locks=$(redis_q KEYS '*lock*')
  if [[ -z "$locks" ]]; then
    echo "• Locks: none"
  else
    echo "• Locks:"
    echo "$locks" | sed 's/^/    /'
  fi

  cal_enabled=$(redis_q GET calibration:enabled)
  echo "• Calibration enabled: ${cal_enabled:-not set}"

  echo "• Outcome counts by category:"
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    count=$(redis_q ZCARD "$key")
    echo "    $key: $count"
  done < <(redis_q KEYS 'outcomes:*')

  rc_size=$(redis_q SCARD 'redeemer:recently-closed')
  echo "• redeemer:recently-closed size: ${rc_size:-0}"
else
  echo "  (redis not available)"
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

  # Also check docker worker logs.
  # Note: docker compose logs --since 24h only covers since the container
  # was last (re)created — after a deploy, earlier history is gone.
  echo ""
  echo "• Docker worker errors (last 24h, since container start):"
  for svc in pga-spot-feed pga-arb pga-copytrade pga-futures pga-telegram pga-sports pga-clob-flow pga-db-writer pga-cron; do
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
# Source of truth is the analytics DB (Epic #142 Phase 3). trade.log only
# covers the OSINT execution pipeline; copytrade/arb/futures trades never
# land there. Docker container logs are ephemeral across deploys. The
# execution_events / positions / outcomes tables are the only reliable
# place to read trade activity, and they span every entry path.
echo "--- TRADES (last 24h) ---"
psql_q() {
  (cd "$PROJECT_DIR" && docker compose exec -T pga-db psql -U pga -d pga -tA -c "$1" 2>/dev/null)
}
if (cd "$PROJECT_DIR" && docker compose ps pga-db 2>/dev/null | grep -q 'Up'); then
  exec_ok=$(psql_q "SELECT COUNT(*) FROM execution_events WHERE created_at > NOW() - INTERVAL '24 hours' AND execution_succeeded = true")
  exec_fail=$(psql_q "SELECT COUNT(*) FROM execution_events WHERE created_at > NOW() - INTERVAL '24 hours' AND execution_succeeded = false")
  by_source=$(psql_q "SELECT source || ':' || COUNT(*) FROM execution_events WHERE created_at > NOW() - INTERVAL '24 hours' AND execution_succeeded = true GROUP BY source ORDER BY source" | tr '\n' ' ')
  top_skips=$(psql_q "SELECT COALESCE(skip_reason::text, 'none') || ':' || COUNT(*) FROM execution_events WHERE created_at > NOW() - INTERVAL '24 hours' AND execution_succeeded = false GROUP BY skip_reason ORDER BY COUNT(*) DESC LIMIT 3" | tr '\n' ' ')
  entered=$(psql_q "SELECT COUNT(*) FROM positions WHERE opened_at > NOW() - INTERVAL '24 hours'")
  closed=$(psql_q "SELECT COUNT(*) FROM outcomes WHERE closed_at > NOW() - INTERVAL '24 hours'")
  won=$(psql_q "SELECT COUNT(*) FROM outcomes WHERE closed_at > NOW() - INTERVAL '24 hours' AND result = 'won'")
  lost=$(psql_q "SELECT COUNT(*) FROM outcomes WHERE closed_at > NOW() - INTERVAL '24 hours' AND result = 'lost'")
  pnl=$(psql_q "SELECT COALESCE(ROUND(SUM(return_pct * stake_usd / 100.0)::numeric, 2), 0) FROM outcomes WHERE closed_at > NOW() - INTERVAL '24 hours'")
  last_trade=$(psql_q "SELECT to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI') || ' ' || source || ' ' || direction || ' mkt=' || market_id || ' \$' || COALESCE(ROUND(stake_usd_executed::numeric, 2)::text, '?') FROM execution_events WHERE execution_succeeded = true ORDER BY created_at DESC LIMIT 1")

  echo "• Executed entries: ${exec_ok:-0}"
  [[ -n "$by_source" ]] && echo "    by source: $by_source"
  echo "• Signal skips: ${exec_fail:-0}"
  [[ -n "$top_skips" ]] && echo "    top reasons: $top_skips"
  echo "• Positions opened (last 24h): ${entered:-0}"
  echo "• Positions closed (last 24h): ${closed:-0} (won: ${won:-0}, lost: ${lost:-0})"
  echo "• Realized P&L (24h): \$${pnl:-0}"
  [[ -n "$last_trade" ]] && echo "• Last trade: $last_trade UTC"
else
  echo "  (pga-db not running — cannot query execution_events)"
fi
echo ""

# --- POSITIONS ---
echo "--- POSITIONS ---"
if redis_available; then
  # Positions are stored as individual `position:{marketId}:{direction}` keys
  # — there is no `positions:active` hash. Use SCAN to count.
  pos_keys=$(redis_q --scan --pattern 'position:*')
  pos_count=$(echo "$pos_keys" | grep -c '^position:' || true)
  echo "• Active positions: ${pos_count:-0}"
  pending=0
  if [[ -n "$pos_keys" && "$pos_count" -gt 0 ]]; then
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      flag=$(redis_q HGET "$key" pendingSettlement)
      [[ "$flag" == "true" ]] && pending=$((pending + 1))
    done <<< "$pos_keys"
  fi
  echo "• Pending settlement: $pending"
fi
# Bankroll isn't persisted in Redis — it's live-computed from Simmer + on-chain
# USDC.e by getBankroll() at trade time. Grep the most recent
# [bankroll] combined balance line from trade.log instead.
if [[ -f "$LOG_DIR/trade.log" ]]; then
  last_bankroll_line=$(grep '\[bankroll\] combined balance' "$LOG_DIR/trade.log" 2>/dev/null | tail -1)
  if [[ -n "$last_bankroll_line" ]]; then
    total=$(echo "$last_bankroll_line" | grep -oE '"totalUsdc":[0-9.]+' | cut -d: -f2)
    ts=$(echo "$last_bankroll_line" | grep -oE '"ts":"[^"]+' | cut -d'"' -f4)
    echo "• Last known bankroll: \$${total:-?} (at $ts)"
  else
    echo "• Last known bankroll: (no recent [bankroll] log in trade.log)"
  fi
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
