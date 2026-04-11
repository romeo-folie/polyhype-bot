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

# 3. Cleanup old images and stale build cache to prevent disk bloat.
# Build cache from `docker compose up --build` accumulates faster than dangling
# images and was the dominant disk eater (~6 GB after a few days). The 24h
# filter keeps recent incremental cache for fast rebuilds while bounding growth.
docker image prune -f
docker builder prune -f --filter "until=24h"

echo ""
echo "✅ Deployment Complete! Your agent workers are running in the background."
echo "💡 View logs:      docker compose logs -f"
echo "💡 View status:    docker compose ps"
echo "💡 Dashboard:     npm run monitor:dashboard"
