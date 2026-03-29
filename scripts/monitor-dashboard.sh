#!/bin/bash
# PGA Monitor Dashboard
# 6-pane tmux session covering all persistent workers and cron logs.
# Uses tail -f on pm2 log files directly — avoids pm2 CLI version incompatibilities.
# Usage: bash scripts/monitor-dashboard.sh

SESSION_NAME="pga"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PM2_LOGS="${HOME}/.pm2/logs"

# Canonical PM2 process names → npm scripts
declare -A WORKERS=(
  ["pga-spot-feed"]="worker:spot-feed"
  ["pga-arb"]="worker:arb"
  ["pga-copytrade"]="worker:copytrade"
  ["pga-futures"]="monitor:futures"
)

cd "$PROJECT_DIR" || exit 1

# Ensure all persistent workers are running under correct names
for name in "${!WORKERS[@]}"; do
  if ! pm2 list | grep -q "$name"; then
    echo "[monitor] Starting $name (npm run ${WORKERS[$name]})"
    pm2 start "npm run ${WORKERS[$name]}" --name "$name"
  fi
done

# Remove stale legacy process names if they exist
for stale in "pga-feeds" "pga-worker"; do
  if pm2 list | grep -q "$stale"; then
    echo "[monitor] Removing stale process: $stale"
    pm2 delete "$stale"
  fi
done

pm2 save --force > /dev/null

# Ensure all log files exist (touch prevents tail from failing on first run)
for name in pga-spot-feed pga-arb pga-copytrade pga-futures; do
  touch "${PM2_LOGS}/${name}-out.log" "${PM2_LOGS}/${name}-error.log" 2>/dev/null || true
done
touch /tmp/pga-trade.log /tmp/pga-monitor.log

# Attach to existing session if it exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[monitor] Session $SESSION_NAME already exists, attaching..."
  tmux attach-session -t "$SESSION_NAME"
  exit 0
fi

echo "[monitor] Creating tmux session: $SESSION_NAME"

# Create session — remain-on-exit keeps panes open if command exits
tmux new-session -d -s "$SESSION_NAME" -n 'Dashboard'
tmux set-option -t "$SESSION_NAME" remain-on-exit on

# Pane 0: spot-feed out log
tmux send-keys -t "$SESSION_NAME:0.0" \
  "echo '=== pga-spot-feed ===' && tail -f '${PM2_LOGS}/pga-spot-feed-out.log'" Enter

# Pane 1: arb out log (split right)
tmux split-window -h -t "$SESSION_NAME:0.0"
tmux send-keys -t "$SESSION_NAME:0.1" \
  "echo '=== pga-arb ===' && tail -f '${PM2_LOGS}/pga-arb-out.log'" Enter

# Pane 2: copytrade out log (split below pane 0)
tmux split-window -v -t "$SESSION_NAME:0.0"
tmux send-keys -t "$SESSION_NAME:0.2" \
  "echo '=== pga-copytrade ===' && tail -f '${PM2_LOGS}/pga-copytrade-out.log'" Enter

# Pane 3: futures out log (split below pane 1)
tmux split-window -v -t "$SESSION_NAME:0.1"
tmux send-keys -t "$SESSION_NAME:0.3" \
  "echo '=== pga-futures ===' && tail -f '${PM2_LOGS}/pga-futures-out.log'" Enter

# Pane 4: OSINT trade cron log
tmux split-window -v -t "$SESSION_NAME:0.2"
tmux send-keys -t "$SESSION_NAME:0.4" \
  "echo '=== cron:trade ===' && tail -f /tmp/pga-trade.log" Enter

# Pane 5: position monitor cron log
tmux split-window -v -t "$SESSION_NAME:0.3"
tmux send-keys -t "$SESSION_NAME:0.5" \
  "echo '=== cron:monitor ===' && tail -f /tmp/pga-monitor.log" Enter

tmux select-layout -t "$SESSION_NAME" tiled
tmux select-pane -t "$SESSION_NAME:0.0"
tmux attach-session -t "$SESSION_NAME"
