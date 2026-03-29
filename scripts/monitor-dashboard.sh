#!/bin/bash
# PGA Monitor Dashboard
# 6-pane tmux session covering all persistent workers and cron logs.
# Usage: bash scripts/monitor-dashboard.sh

SESSION_NAME="pga"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Canonical PM2 process names → npm scripts
declare -A WORKERS=(
  ["pga-spot-feed"]="worker:spot-feed"
  ["pga-arb"]="worker:arb"
  ["pga-copytrade"]="worker:copytrade"
  ["pga-futures"]="monitor:futures"
)

# Ensure all persistent workers are running under correct names
cd "$PROJECT_DIR" || exit 1
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

# Attach or create tmux session
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[monitor] Session $SESSION_NAME already exists, attaching..."
  tmux attach-session -t "$SESSION_NAME"
  exit 0
fi

echo "[monitor] Creating tmux session: $SESSION_NAME"

# Pane layout (tiled, 6 panes):
# ┌──────────────────┬──────────────────┐
# │ spot-feed logs   │ arb logs         │
# ├──────────────────┼──────────────────┤
# │ copytrade logs   │ futures logs     │
# ├──────────────────┼──────────────────┤
# │ trade cron log   │ monitor cron log │
# └──────────────────┴──────────────────┘

tmux new-session -d -s "$SESSION_NAME" -n 'Dashboard' \
  "pm2 logs pga-spot-feed --nocolor"

tmux split-window -h -t "$SESSION_NAME" \
  "pm2 logs pga-arb --nocolor"

tmux split-window -v -t "$SESSION_NAME:0.0" \
  "pm2 logs pga-copytrade --nocolor"

tmux split-window -v -t "$SESSION_NAME:0.1" \
  "pm2 logs pga-futures --nocolor"

tmux split-window -v -t "$SESSION_NAME:0.2" \
  "tail -f /tmp/pga-trade.log"

tmux split-window -v -t "$SESSION_NAME:0.3" \
  "tail -f /tmp/pga-monitor.log"

tmux select-layout -t "$SESSION_NAME" tiled
tmux attach-session -t "$SESSION_NAME"
