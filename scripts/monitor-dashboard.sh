#!/bin/sh
# PGA Monitor Dashboard — 6 panes in 2 columns x 3 rows (even-horizontal layout)
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

# sed colorizes [component-labels] with per-pane ANSI colors
W0="tail -f '${PM2_LOGS}/pga-spot-feed-out.log' | sed 's/\(\[[^]]*\]\)/\x1b[36m\1\x1b[0m/g'"
W1="tail -f '${PM2_LOGS}/pga-arb-out.log'       | sed 's/\(\[[^]]*\]\)/\x1b[33m\1\x1b[0m/g'"
W2="tail -f '${PM2_LOGS}/pga-copytrade-out.log'  | sed 's/\(\[[^]]*\]\)/\x1b[32m\1\x1b[0m/g'"
W3="tail -f '${PM2_LOGS}/pga-futures-out.log'    | sed 's/\(\[[^]]*\]\)/\x1b[35m\1\x1b[0m/g'"
W4="tail -f /tmp/pga-trade.log                   | sed 's/\(\[[^]]*\]\)/\x1b[34m\1\x1b[0m/g'"
W5="tail -f /tmp/pga-monitor.log                 | sed 's/\(\[[^]]*\]\)/\x1b[31m\1\x1b[0m/g'"

# Create 6 windows, join into one, then use even-horizontal (2 columns)
tmux new-session  -d -s "$SESSION" -n spot-feed   "sh -c \"$W0\""
tmux new-window      -t "$SESSION"  -n arb         "sh -c \"$W1\""
tmux new-window      -t "$SESSION"  -n copytrade   "sh -c \"$W2\""
tmux new-window      -t "$SESSION"  -n futures     "sh -c \"$W3\""
tmux new-window      -t "$SESSION"  -n trade-log   "sh -c \"$W4\""
tmux new-window      -t "$SESSION"  -n monitor-log "sh -c \"$W5\""

tmux join-pane -s "${SESSION}:arb"         -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:copytrade"   -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:futures"     -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:trade-log"   -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:monitor-log" -t "${SESSION}:spot-feed"

# even-horizontal: 2 equal columns, panes stacked vertically within each column
# Each pane gets 1/3 of terminal height — more space than tiled's 1/3 of full grid
tmux select-layout  -t "${SESSION}:spot-feed" even-horizontal
tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "${SESSION}:spot-feed.0"
tmux attach-session -t "$SESSION"
