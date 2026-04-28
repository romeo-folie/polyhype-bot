#!/bin/bash
set -e

# PGA Automated Deployment Script for Raspberry Pi
echo "🚀 Starting Automated Agent Deployment..."

# 1. Pull latest code from main
# Note: This assumes you are on the main branch on the Pi
git pull origin main

# 2. Pre-build prune: free space before parallel image extraction.
# Without this, building all services simultaneously can exhaust disk during
# the containerd layer-unpack phase even when df shows headroom (burned 2026-04-28).
docker image prune -f
docker builder prune -f --filter "until=24h"

# 3. Rebuild and restart services in detached mode
# Docker Compose will only restart services whose code has changed.
docker compose up -d --build

# 4. Post-build cleanup of any newly dangling images and residual cache.
docker image prune -f
docker builder prune -f --filter "until=24h"

echo ""
echo "✅ Deployment Complete! Your agent workers are running in the background."
echo "💡 View logs:      docker compose logs -f"
echo "💡 View status:    docker compose ps"
echo "💡 Dashboard:     npm run monitor:dashboard"
