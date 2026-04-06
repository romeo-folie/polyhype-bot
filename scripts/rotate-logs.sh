#!/bin/bash
# rotate-logs.sh — Simple size-based log rotation for PGA cron logs.
# Rotates any log > 5MB, keeping 1 backup (.log.1).
# Cron: 0 4 * * * /home/romeofolie/Projects/polymarket-geopolitical-agent/scripts/rotate-logs.sh

set -euo pipefail

LOG_DIR="$HOME/logs/pga"
MAX_BYTES=$((5 * 1024 * 1024))  # 5 MB

if [[ ! -d "$LOG_DIR" ]]; then
  exit 0
fi

for logfile in "$LOG_DIR"/*.log; do
  [[ -f "$logfile" ]] || continue
  size=$(stat -c%s "$logfile" 2>/dev/null || echo 0)
  if (( size > MAX_BYTES )); then
    mv "$logfile" "${logfile}.1"
    echo "[$(date -Iseconds)] Rotated $(basename "$logfile") (${size} bytes)" >> "$LOG_DIR/rotation.log"
  fi
done
