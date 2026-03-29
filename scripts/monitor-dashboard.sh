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

# Attach to existing session if it exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[monitor] Session $SESSION_NAME already exists, attaching..."
  tmux attach-session -t "$SESSION_NAME"
  exit 0
fi

echo "[monitor] Creating tmux session: $SESSION_NAME"

# Helper: keep pane alive after command exits (shows exit status + waits for keypress)
KEEP_ALIVE='read -p "[pane exited — press Enter to close]"'

# Create session with first pane
tmux new-session -d -s "$SESSION_NAME" -n 'Dashboard'

# Set all panes to stay alive on exit (tmux global option)
tmux set-option -t "$SESSION_NAME" remain-on-exit on

# Pane 0: spot-feed
tmux send-keys -t "$SESSION_NAME:0.0" "pm2 logs pga-spot-feed --nocolor 2>&1 || echo '[pga-spot-feed not running]'; $KEEP_ALIVE" Enter

# Pane 1: arb (split right)
tmux split-window -h -t "$SESSION_NAME:0.0"
tmux send-keys -t "$SESSION_NAME:0.1" "pm2 logs pga-arb --nocolor 2>&1 || echo '[pga-arb not running]'; $KEEP_ALIVE" Enter

# Pane 2: copytrade (split below pane 0)
tmux split-window -v -t "$SESSION_NAME:0.0"
tmux send-keys -t "$SESSION_NAME:0.2" "pm2 logs pga-copytrade --nocolor 2>&1 || echo '[pga-copytrade not running]'; $KEEP_ALIVE" Enter

# Pane 3: futures (split below pane 1)
tmux split-window -v -t "$SESSION_NAME:0.1"
tmux send-keys -t "$SESSION_NAME:0.3" "pm2 logs pga-futures --nocolor 2>&1 || echo '[pga-futures not running]'; $KEEP_ALIVE" Enter

# Pane 4: trade cron log (split below pane 2)
tmux split-window -v -t "$SESSION_NAME:0.2"
tmux send-keys -t "$SESSION_NAME:0.4" "touch /tmp/pga-trade.log && tail -f /tmp/pga-trade.log" Enter

# Pane 5: monitor cron log (split below pane 3)
tmux split-window -v -t "$SESSION_NAME:0.3"
tmux send-keys -t "$SESSION_NAME:0.5" "touch /tmp/pga-monitor.log && tail -f /tmp/pga-monitor.log" Enter

tmux select-layout -t "$SESSION_NAME" tiled
tmux select-pane -t "$SESSION_NAME:0.0"
tmux attach-session -t "$SESSION_NAME"
