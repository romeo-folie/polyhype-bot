#!/bin/sh
# PGA Monitor Dashboard — 6 panes in 2 columns x 3 rows
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

# Build layout: LEFT column (3 panes) | RIGHT column (3 panes)
# Step 1: create session with left-top pane
tmux new-session -d -s "$SESSION" -n Dashboard \
  "tail -f '${PM2_LOGS}/pga-spot-feed-out.log'"

# Step 2: split right — creates right column (pane 1)
tmux split-window -h -t "${SESSION}:Dashboard.0" \
  "tail -f '${PM2_LOGS}/pga-arb-out.log'"

# Step 3: split left-top downward — pane 2 (left-middle)
tmux split-window -v -t "${SESSION}:Dashboard.0" \
  "tail -f '${PM2_LOGS}/pga-copytrade-out.log'"

# Step 4: split left-middle downward — pane 3 (left-bottom)
tmux split-window -v -t "${SESSION}:Dashboard.2" \
  "tail -f '${PM2_LOGS}/pga-futures-out.log'"

# Step 5: split right-top downward — pane 4 (right-middle)
tmux split-window -v -t "${SESSION}:Dashboard.1" \
  "tail -f /tmp/pga-trade.log"

# Step 6: split right-middle downward — pane 5 (right-bottom)
tmux split-window -v -t "${SESSION}:Dashboard.4" \
  "tail -f /tmp/pga-monitor.log"

tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "${SESSION}:Dashboard.0"
tmux attach-session -t "$SESSION"
