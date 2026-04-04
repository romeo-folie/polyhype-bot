#!/bin/bash
set -e

# PGA Automated Deployment Script for Raspberry Pi
echo "🚀 Starting Automated Agent Deployment..."

# 1. Pull latest code from main
# Note: This assumes you are on the main branch on the Pi
git pull origin main

# 2. Rebuild and restart services in detached mode
# Docker Compose will only restart services whose code has changed.
docker compose up -d --build

# 3. Cleanup old images to prevent SD card bloat
docker image prune -f

echo ""
echo "✅ Deployment Complete! Your agent workers are running in the background."
echo "💡 View logs:      docker compose logs -f"
echo "💡 View status:    docker compose ps"
echo "💡 Dashboard:     npm run monitor:dashboard"
