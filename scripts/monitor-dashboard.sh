#!/bin/sh
# PGA Monitor Dashboard
# 6-pane tmux session — all persistent workers + cron logs.
# Usage: ./scripts/monitor-dashboard.sh
# Compatible with bash, zsh, dash (POSIX sh).

SESSION="pga"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PM2_LOGS="${HOME}/.pm2/logs"

# ── Dependency checks ──────────────────────────────────────────────────────────
for cmd in pm2 tmux; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH." >&2; exit 1
  fi
done

cd "$PROJECT_DIR" || exit 1

# ── Start missing workers ──────────────────────────────────────────────────────
start_if_missing() {
  name="$1"; script="$2"
  if ! pm2 list | grep -q "$name"; then
    echo "[monitor] starting $name"
    pm2 start "npm run $script" --name "$name"
  fi
}

start_if_missing pga-spot-feed  "worker:spot-feed"
start_if_missing pga-arb        "worker:arb"
start_if_missing pga-copytrade  "worker:copytrade"
start_if_missing pga-futures    "monitor:futures"

# Remove stale legacy names
for stale in pga-feeds pga-worker; do
  pm2 list | grep -q "$stale" && pm2 delete "$stale" || true
done

pm2 save --force >/dev/null 2>&1

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

echo "[monitor] creating tmux session: $SESSION"

# ── Build dashboard ────────────────────────────────────────────────────────────
# Commands passed directly to split-window — no send-keys, no timing races.

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
