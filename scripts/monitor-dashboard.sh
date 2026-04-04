#!/bin/sh
# PGA Monitor Dashboard — 8 panes in 2x4 grid
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
start_if_missing pga-telegram  "worker:telegram"

for stale in pga-feeds pga-worker; do
  pm2 list | grep -q "$stale" && pm2 delete "$stale" || true
done
pm2 save --force >/dev/null 2>&1

for name in pga-spot-feed pga-arb pga-copytrade pga-futures pga-telegram; do
  touch "${PM2_LOGS}/${name}-out.log" 2>/dev/null || true
done
touch /tmp/pga-trade.log /tmp/pga-monitor.log /tmp/pga-spot.log

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach-session -t "$SESSION"
  exit 0
fi

W0="tail -f '${PM2_LOGS}/pga-spot-feed-out.log' | sed 's/\(\[[^]]*\]\)/\x1b[36m\1\x1b[0m/g'"
W1="tail -f '${PM2_LOGS}/pga-arb-out.log'       | sed 's/\(\[[^]]*\]\)/\x1b[33m\1\x1b[0m/g'"
W2="tail -f '${PM2_LOGS}/pga-copytrade-out.log'  | sed 's/\(\[[^]]*\]\)/\x1b[32m\1\x1b[0m/g'"
W3="tail -f '${PM2_LOGS}/pga-futures-out.log'    | sed 's/\(\[[^]]*\]\)/\x1b[35m\1\x1b[0m/g'"
W4="tail -f '${PM2_LOGS}/pga-telegram-out.log'   | sed 's/\(\[[^]]*\]\)/\x1b[92m\1\x1b[0m/g'"
W5="tail -f /tmp/pga-trade.log                   | sed 's/\(\[[^]]*\]\)/\x1b[34m\1\x1b[0m/g'"
W6="tail -f /tmp/pga-monitor.log                 | sed 's/\(\[[^]]*\]\)/\x1b[96m\1\x1b[0m/g'"
W7="while true; do clear; npx tsx scripts/list-positions.ts; sleep 10; done"

# Partition the window into a deterministic 2x4 grid
# Start with the first worker (Spot Feed)
tmux new-session  -d -s "$SESSION" -n w0 -x 220 -y 60 "sh -c \"$W0\""

# 1. Split vertically for two rows. Top=Workers, Bottom=Logs
tmux split-window -v -t "${SESSION}:w0.0" "sh -c \"$W4\""

# 2. Split Top row into 4 columns (W1, W2, W3 joined with W0)
tmux split-window -h -t "${SESSION}:w0.0" "sh -c \"$W1\""
tmux split-window -h -t "${SESSION}:w0.0" "sh -c \"$W2\""
tmux split-window -h -t "${SESSION}:w0.0" "sh -c \"$W3\""

# 3. Split Bottom row into 4 columns (W5, W6, W7 joined with W4)
tmux split-window -h -t "${SESSION}:w0.1" "sh -c \"$W5\""
tmux split-window -h -t "${SESSION}:w0.1" "sh -c \"$W6\""
tmux split-window -h -t "${SESSION}:w0.1" "sh -c \"$W7\""

# Force balance and select primary focus
tmux select-layout -t "${SESSION}:w0" tiled
tmux set-option  -t "$SESSION" remain-on-exit on
tmux select-pane -t "${SESSION}:w0.0"
tmux attach-session -t "$SESSION"
