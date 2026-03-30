#!/bin/sh
# PGA Monitor Dashboard — 6 panes with colored component labels
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

# Color code: sed highlights [component-name] in square brackets
# Each pane gets a distinct color for its component labels:
#   cyan    = spot/feed/pyth/binance
#   yellow  = arb/scanner/crypto
#   green   = copytrade/shortlist/bankroll
#   magenta = futures/hyperliquid/executor/hedge
#   blue    = trade pipeline (osint/ingestion/mapping/consensus/reeval/redeemer)
#   red     = monitor/take-profit/stop-loss

# sed expression: colorize anything in [square-brackets] with the given ANSI code
color_cmd() {
  color="$1"; logfile="$2"
  # ANSI: \033[<code>m = color on, \033[0m = reset
  tail -f "$logfile" | sed "s/\(\[[^]]*\]\)/\\033[${color}m\\1\\033[0m/g"
}

# Colors: 36=cyan 33=yellow 32=green 35=magenta 34=blue 31=red
tmux new-session  -d -s "$SESSION" -n spot-feed   "$(color_cmd 36 "${PM2_LOGS}/pga-spot-feed-out.log")"
tmux new-window      -t "$SESSION"  -n arb         "$(color_cmd 33 "${PM2_LOGS}/pga-arb-out.log")"
tmux new-window      -t "$SESSION"  -n copytrade   "$(color_cmd 32 "${PM2_LOGS}/pga-copytrade-out.log")"
tmux new-window      -t "$SESSION"  -n futures     "$(color_cmd 35 "${PM2_LOGS}/pga-futures-out.log")"
tmux new-window      -t "$SESSION"  -n trade-log   "$(color_cmd 34 /tmp/pga-trade.log)"
tmux new-window      -t "$SESSION"  -n monitor-log "$(color_cmd 31 /tmp/pga-monitor.log)"

# Join all windows into the first window as panes
tmux join-pane -s "${SESSION}:arb"         -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:copytrade"   -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:futures"     -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:trade-log"   -t "${SESSION}:spot-feed"
tmux join-pane -s "${SESSION}:monitor-log" -t "${SESSION}:spot-feed"

tmux select-layout  -t "${SESSION}:spot-feed" tiled
tmux set-option     -t "$SESSION" remain-on-exit on
tmux select-pane    -t "${SESSION}:spot-feed.0"
tmux attach-session -t "$SESSION"
