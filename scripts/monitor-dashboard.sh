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

# Create 6 separate windows, one per log source
tmux new-session  -d -s "$SESSION" -n spot-feed  "tail -f '${PM2_LOGS}/pga-spot-feed-out.log'"
tmux new-window      -t "$SESSION"  -n arb        "tail -f '${PM2_LOGS}/pga-arb-out.log'"
tmux new-window      -t "$SESSION"  -n copytrade  "tail -f '${PM2_LOGS}/pga-copytrade-out.log'"
tmux new-window      -t "$SESSION"  -n futures    "tail -f '${PM2_LOGS}/pga-futures-out.log'"
tmux new-window      -t "$SESSION"  -n trade-log  "tail -f /tmp/pga-trade.log"
tmux new-window      -t "$SESSION"  -n monitor-log "tail -f /tmp/pga-monitor.log"

# Join all windows into window 0 as panes
tmux join-pane -s "${SESSION}:arb"         -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:copytrade"   -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:futures"     -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:trade-log"   -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:monitor-log" -t "${SESSION}:spot-feed"

tmux select-layout  -t "${SESSION}:spot-feed" tiled
tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "${SESSION}:spot-feed.0"
tmux attach-session -t "$SESSION"
