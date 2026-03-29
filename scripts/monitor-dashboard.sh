#!/usr/bin/env bash
# PGA Monitor Dashboard
# 6-pane tmux session — all persistent workers + cron logs.
# Usage: bash scripts/monitor-dashboard.sh  (run from anywhere)

set -e

SESSION="pga"
PM2_LOGS="${HOME}/.pm2/logs"
PROJECT_DIR="${0:a:h:h}"   # zsh: absolute path of this script's parent directory

# ── Dependency checks ──────────────────────────────────────────────────────────
for cmd in pm2 tmux; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found in PATH." >&2; exit 1
  fi
done

# ── Start missing workers ──────────────────────────────────────────────────────
cd "$PROJECT_DIR"

typeset -A WORKERS
WORKERS=(
  pga-spot-feed  "worker:spot-feed"
  pga-arb        "worker:arb"
  pga-copytrade  "worker:copytrade"
  pga-futures    "monitor:futures"
)

for name script in ${(kv)WORKERS}; do
  if ! pm2 list | grep -qw "$name"; then
    echo "[monitor] starting $name"
    pm2 start "npm run $script" --name "$name"
  fi
done

# Remove stale legacy names
for stale in pga-feeds pga-worker; do
  pm2 list | grep -qw "$stale" && pm2 delete "$stale" || true
done

pm2 save --force &>/dev/null

# ── Ensure log files exist ─────────────────────────────────────────────────────
for name in pga-spot-feed pga-arb pga-copytrade pga-futures; do
  touch "${PM2_LOGS}/${name}-out.log" 2>/dev/null || true
done
touch /tmp/pga-trade.log /tmp/pga-monitor.log

# ── Attach if session already running ─────────────────────────────────────────
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "[monitor] attaching to existing session..."
  tmux attach-session -t "$SESSION"
  exit 0
fi

# ── Build dashboard ────────────────────────────────────────────────────────────
# Pass commands directly to split-window — no send-keys, no timing race.
# Layout (tiled, 2 columns x 3 rows):
#  spot-feed  │  arb
#  copytrade  │  futures
#  cron:trade │  cron:monitor

tmux new-session  -d -s "$SESSION" -n Dashboard \
  "tail -f '${PM2_LOGS}/pga-spot-feed-out.log'"

tmux split-window -t "$SESSION" \
  "tail -f '${PM2_LOGS}/pga-arb-out.log'"

tmux split-window -t "$SESSION" \
  "tail -f '${PM2_LOGS}/pga-copytrade-out.log'"

tmux split-window -t "$SESSION" \
  "tail -f '${PM2_LOGS}/pga-futures-out.log'"

tmux split-window -t "$SESSION" \
  "tail -f /tmp/pga-trade.log"

tmux split-window -t "$SESSION" \
  "tail -f /tmp/pga-monitor.log"

tmux select-layout  -t "$SESSION" tiled
tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "$SESSION:0.0"
tmux attach-session -t "$SESSION"
