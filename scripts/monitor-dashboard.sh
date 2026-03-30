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

# ── Build 6-pane layout ────────────────────────────────────────────────────────
# Strategy: create a 3-window session, each window split into 2 panes side-by-side.
# Window 1: Workers (spot-feed | arb)
# Window 2: Workers (copytrade | futures)
# Window 3: Cron logs (trade | monitor)
# Then merge into a single window with 6 panes using join-pane.
#
# Simpler approach: build left column first, then right column using split-h/v targeting.

# Window with pane 0: spot-feed
tmux new-session -d -s "$SESSION" -n Dashboard \
  "tail -f '${PM2_LOGS}/pga-spot-feed-out.log'"

# Split pane 0 vertically → pane 1: arb
tmux split-window -v -t "${SESSION}:0.0" \
  "tail -f '${PM2_LOGS}/pga-arb-out.log'"

# Split pane 1 vertically → pane 2: copytrade
tmux split-window -v -t "${SESSION}:0.1" \
  "tail -f '${PM2_LOGS}/pga-copytrade-out.log'"

# Split pane 0 horizontally → pane 3: futures (right of spot-feed)
tmux split-window -h -t "${SESSION}:0.0" \
  "tail -f '${PM2_LOGS}/pga-futures-out.log'"

# Split pane 3 vertically → pane 4: cron:trade
tmux split-window -v -t "${SESSION}:0.3" \
  "tail -f /tmp/pga-trade.log"

# Split pane 4 vertically → pane 5: cron:monitor
tmux split-window -v -t "${SESSION}:0.4" \
  "tail -f /tmp/pga-monitor.log"

tmux select-layout  -t "$SESSION" tiled
tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "${SESSION}:0.0"
tmux attach-session -t "$SESSION"
