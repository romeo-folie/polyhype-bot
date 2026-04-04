#!/bin/sh
# PGA Monitor Dashboard (Docker Integrated) — 9 panes in 3x3 tiled grid
# Usage: ./scripts/monitor-dashboard.sh

SESSION="pga"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Verification
for cmd in docker tmux; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found." >&2; exit 1
  fi
done

cd "$PROJECT_DIR" || exit 1

# Optional: ensure stack is running if needed
# docker compose up -d

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach-session -t "$SESSION"
  exit 0
fi

# DOCKER WORKER LOGS (Color coded)
W0="docker compose logs -f --tail 100 pga-spot-feed | sed 's/\(\[[^]]*\]\)/\x1b[36m\1\x1b[0m/g'"
W1="docker compose logs -f --tail 100 pga-arb       | sed 's/\(\[[^]]*\]\)/\x1b[33m\1\x1b[0m/g'"
W2="docker compose logs -f --tail 100 pga-copytrade | sed 's/\(\[[^]]*\]\)/\x1b[32m\1\x1b[0m/g'"
W3="docker compose logs -f --tail 100 pga-telegram  | sed 's/\(\[[^]]*\]\)/\x1b[92m\1\x1b[0m/g'"

# CRON LOGS (From /tmp)
W4="touch /tmp/pga-trade.log && tail -f /tmp/pga-trade.log | sed 's/\(\[[^]]*\]\)/\x1b[34m\1\x1b[0m/g'"
W5="touch /tmp/pga-monitor.log && tail -f /tmp/pga-monitor.log | sed 's/\(\[[^]]*\]\)/\x1b[35m\1\x1b[0m/g'"
W6="touch /tmp/pga-spot.log && tail -f /tmp/pga-spot.log | sed 's/\(\[[^]]*\]\)/\x1b[96m\1\x1b[0m/g'"
W7="touch /tmp/pga-shortlist.log && tail -f /tmp/pga-shortlist.log | sed 's/\(\[[^]]*\]\)/\x1b[95m\1\x1b[0m/g'"

# LEDGER VIEW
W8="while true; do npx tsx scripts/list-positions.ts; sleep 10; done"

# Partition the window into a dynamic tiled grid
# This results in a 3x3 layout.
tmux new-session -d -s "$SESSION" -n w0 -x 220 -y 60 "sh -c \"$W0\""

# Spawn panes 1 through 8
for cmd in "$W1" "$W2" "$W3" "$W4" "$W5" "$W6" "$W7" "$W8"; do
  tmux split-window -t "${SESSION}:w0" "sh -c \"$cmd\""
  tmux select-layout -t "${SESSION}:w0" tiled
done

# Select first pane and attach
tmux set-option -t "$SESSION" remain-on-exit on
tmux select-pane -t "${SESSION}:w0.0"
tmux attach-session -t "$SESSION"
