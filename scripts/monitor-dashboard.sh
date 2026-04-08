#!/bin/sh
# PGA Monitor Dashboard (Docker Integrated) — 12 panes in 3x4 tiled grid
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

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach-session -t "$SESSION"
  exit 0
fi

# DOCKER WORKER LOGS (Standard 1-5 Workers)
W0="docker compose logs -f --tail 100 pga-spot-feed | sed 's/\(\[[^]]*\]\)/\x1b[36m\1\x1b[0m/g'"
W1="docker compose logs -f --tail 100 pga-arb       | sed 's/\(\[[^]]*\]\)/\x1b[33m\1\x1b[0m/g'"
W2="docker compose logs -f --tail 100 pga-copytrade | sed 's/\(\[[^]]*\]\)/\x1b[32m\1\x1b[0m/g'"
W3="docker compose logs -f --tail 100 pga-futures   | sed 's/\(\[[^]]*\]\)/\x1b[35m\1\x1b[0m/g'"
W4="docker compose logs -f --tail 100 pga-telegram  | sed 's/\(\[[^]]*\]\)/\x1b[92m\1\x1b[0m/g'"

# CRON LOGS (6-8 From /tmp)
W5="touch ~/logs/pga/trade.log && tail -f ~/logs/pga/trade.log | sed 's/\(\[[^]]*\]\)/\x1b[34m\1\x1b[0m/g'"
W6="touch ~/logs/pga/monitor.log && tail -f ~/logs/pga/monitor.log | sed 's/\(\[[^]]*\]\)/\x1b[96m\1\x1b[0m/g'"
W7="touch ~/logs/pga/spot.log && tail -f ~/logs/pga/spot.log | sed 's/\(\[[^]]*\]\)/\x1b[95m\1\x1b[0m/g'"

# POSITION DISPLAY (9)
W8="while true; do npx tsx scripts/list-positions.ts; sleep 10; done"

# NEW DOCKER WORKERS (10-11)
W9="docker compose logs -f --tail 100 pga-sports    | sed 's/\(\[[^]]*\]\)/\x1b[91m\1\x1b[0m/g'"
W10="docker compose logs -f --tail 100 pga-clob-flow | sed 's/\(\[[^]]*\]\)/\x1b[93m\1\x1b[0m/g'"

# MAKER-EXIT + TRAILING-STOP focus pane (12)
W11="touch ~/logs/pga/monitor.log && tail -f ~/logs/pga/monitor.log | grep --line-buffered -E 'maker_exit_|trailing_stop|stale-exit triggered' | sed 's/\(\[[^]]*\]\)/\x1b[94m\1\x1b[0m/g'"

# Partition the window into a dynamic tiled grid
tmux new-session -d -s "$SESSION" -n w0 -x 220 -y 60 "sh -c \"$W0\""

# Spawn panes 1 through 10
for cmd in "$W1" "$W2" "$W3" "$W4" "$W5" "$W6" "$W7" "$W8" "$W9" "$W10" "$W11"; do
  tmux split-window -t "${SESSION}:w0" "sh -c \"$cmd\""
  tmux select-layout -t "${SESSION}:w0" tiled
done

# Select first pane and attach
tmux set-option -t "$SESSION" remain-on-exit on
tmux set-option -t "$SESSION" mouse on
tmux select-pane -t "${SESSION}:w0.0"
tmux attach-session -t "$SESSION"
