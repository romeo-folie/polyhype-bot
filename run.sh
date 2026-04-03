#!/bin/bash
# run.sh — cron wrapper: loads .env, acquires per-script flock, then exec's the command.
#
# flock(1) prevents a second cron tick from starting while the previous run is still
# alive. The lock file is keyed by the script name so each pipeline has its own gate.
# Redis-level locks inside each entrypoint provide a second layer for any case where
# two hosts share the same Redis instance.
#
# Usage:
#   ./run.sh npx tsx src/execution/index.ts
#   ./run.sh npx tsx src/monitor/index.ts
#   ./run.sh npx tsx src/spot/index.ts
#   ./run.sh npx tsx src/arb/index.ts
#
# NOTE: This wrapper is for SHORT-LIVED cron tasks. 
#       DO NOT use it for persistent workers (e.g. src/copytrade/worker.ts, src/ingestion/telegramMonitor.ts)
#       as flock(1) will block subsequent manual restarts or health checks.
#       Persistent workers should be managed via PM2, systemd, or equivalent.
#
# Crontab example (use absolute paths; redirect logs):
#   */5 * * * * /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/execution/index.ts >> /tmp/pga-trade.log 2>&1
#   */5 * * * * /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/monitor/index.ts >> /tmp/pga-monitor.log 2>&1
#   * * * * *   /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/spot/index.ts >> /tmp/pga-spot.log 2>&1
#   */15 * * * * /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/arb/index.ts >> /tmp/pga-arb.log 2>&1
#   0 6 * * MON /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/copytrade/shortlist.ts >> /tmp/pga-copytrade-shortlist.log 2>&1

set -euo pipefail

ENV_FILE="$(dirname "$0")/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Aborting." >&2
  exit 1
fi

set -a
# shellcheck source=.env
source "$ENV_FILE"
set +a

# Derive a lock-file name from the last path component of the script being run.
# e.g. "npx tsx src/monitor/index.ts" -> lock file "/tmp/pga-monitor.lock"
SCRIPT_NAME=""
for arg in "$@"; do
  if [[ "$arg" == *.ts ]]; then
    SCRIPT_NAME="$(basename "$(dirname "$arg")")"
    break
  fi
done
LOCK_FILE="/tmp/pga-${SCRIPT_NAME:-default}.lock"

# flock -n: non-blocking — exits immediately if lock is held (previous run still alive).
exec flock -n "$LOCK_FILE" "$@"
