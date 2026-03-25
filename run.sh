#!/bin/bash
# run.sh — wrapper for cron jobs that loads .env before executing a command.
#
# Usage:
#   ./run.sh npx tsx src/execution/index.ts
#   ./run.sh npx tsx src/monitor/index.ts
#   ./run.sh npx tsx src/spot/index.ts
#
# Crontab example:
#   */5 * * * * /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/execution/index.ts >> /tmp/pga-trade.log 2>&1
#   */5 * * * * /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/monitor/index.ts >> /tmp/pga-monitor.log 2>&1
#   * * * * *   /home/romeofolie/Projects/polymarket-geopolitical-agent/run.sh npx tsx /home/romeofolie/Projects/polymarket-geopolitical-agent/src/spot/index.ts >> /tmp/pga-spot.log 2>&1

set -a
# shellcheck source=.env
source "$(dirname "$0")/.env"
set +a

exec "$@"
