#!/bin/sh
# PGA Monitor Dashboard — 6 panes
# Usage: ./scripts/monitor-dashboard.sh

SESSION="pga"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PM2_LOGS="${HOME}/.pm2/logs"

for cmd in pm2 tmux; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found." >&2; exit 1
  fi
done

cd "$PROJECT_DIR" || exit 1

start_if_missing() {
  name="$1"; script="$2"
  if ! pm2 list | grep -q "$name"; then
    echo "[monitor] starting $name"
    pm2 start "npm run $script" --name "$name"
  fi
}

start_if_missing pga-spot-feed "worker:spot-feed"
start_if_missing pga-arb       "worker:arb"
start_if_missing pga-copytrade "worker:copytrade"
start_if_missing pga-futures   "monitor:futures"

for stale in pga-feeds pga-worker; do
  pm2 list | grep -q "$stale" && pm2 delete "$stale" || true
done
pm2 save --force >/dev/null 2>&1

for name in pga-spot-feed pga-arb pga-copytrade pga-futures; do
  touch "${PM2_LOGS}/${name}-out.log" 2>/dev/null || true
done
touch /tmp/pga-trade.log /tmp/pga-monitor.log

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach-session -t "$SESSION"
  exit 0
fi

# Create session with pane 0 — spot-feed
tmux new-session -d -s "$SESSION" -n Dashboard \
  "tail -f '${PM2_LOGS}/pga-spot-feed-out.log'"

# Always split the FIRST pane (index 0) to grow the list downward
# Each new split-window without -t defaults to most-recently-active,
# so we explicitly target pane 0 each time then rebalance at the end.

# Pane 1: arb
tmux split-window -t "${SESSION}:Dashboard.0" \
  "tail -f '${PM2_LOGS}/pga-arb-out.log'"

# Pane 2: copytrade
tmux split-window -t "${SESSION}:Dashboard.0" \
  "tail -f '${PM2_LOGS}/pga-copytrade-out.log'"

# Pane 3: futures
tmux split-window -t "${SESSION}:Dashboard.0" \
  "tail -f '${PM2_LOGS}/pga-futures-out.log'"

# Pane 4: cron:trade
tmux split-window -t "${SESSION}:Dashboard.0" \
  "tail -f /tmp/pga-trade.log"

# Pane 5: cron:monitor
tmux split-window -t "${SESSION}:Dashboard.0" \
  "tail -f /tmp/pga-monitor.log"

# Rebalance into a clean tiled grid
tmux select-layout  -t "$SESSION" tiled
tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "${SESSION}:Dashboard.0"
tmux attach-session -t "$SESSION"
