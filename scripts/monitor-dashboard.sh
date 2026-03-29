#!/bin/bash
# High-Performance PGA Dashboard
# Starts a 6-pane tmux session to monitor all real-time workers and cron logs.

SESSION_NAME="pga"

# Check if session already exists
tmux has-session -t $SESSION_NAME 2>/dev/null

if [ $? != 0 ]; then
  echo "[monitor] Creating new tmux session: $SESSION_NAME"
  
  # Ensure PM2 workers are running
  pm2 list | grep -q "pga-feeds" || pm2 start "npx tsx src/spot/feeds/manager.ts" --name pga-feeds
  pm2 list | grep -q "pga-arb" || pm2 start "npx tsx src/arb/worker.ts" --name pga-arb
  pm2 list | grep -q "pga-worker" || pm2 start "npx tsx src/copytrade/worker.ts" --name pga-worker
  pm2 list | grep -q "pga-futures" || pm2 start "npx tsx src/monitor/futuresMonitor.ts" --name pga-futures

  # Create session and first pane (Feeds)
  tmux new-session -d -s $SESSION_NAME -n 'Dashboard' 'pm2 logs pga-feeds'
  
  # Split 1: Arb Worker
  tmux split-window -h -t $SESSION_NAME 'pm2 logs pga-arb'
  
  # Split 2: News Pipeline
  tmux split-window -v -t $SESSION_NAME 'tail -f /tmp/pga-trade.log'
  
  # Select first pane and split for Copytrade
  tmux select-pane -t $SESSION_NAME:0.0
  tmux split-window -v -t $SESSION_NAME 'pm2 logs pga-worker'
  
  # Select pane 2 and split for Monitor
  tmux select-pane -t $SESSION_NAME:0.2
  tmux split-window -v -t $SESSION_NAME 'tail -f /tmp/pga-monitor.log'

  # Select pane 4 and split for Futures Monitor
  tmux select-pane -t $SESSION_NAME:0.4
  tmux split-window -v -t $SESSION_NAME 'pm2 logs pga-futures'
  
  # Select pane 5 and split for PM2 Monitor
  tmux select-pane -t $SESSION_NAME:0.5
  tmux split-window -v -t $SESSION_NAME 'pm2 monit'
  
  # Equalize panes
  tmux select-layout -t $SESSION_NAME tiled

else
  echo "[monitor] Session $SESSION_NAME already exists, attaching..."
fi

tmux attach-session -t $SESSION_NAME
