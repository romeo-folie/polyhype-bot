#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy.sh <service> [service...]
  scripts/deploy.sh --all

Examples:
  scripts/deploy.sh pga-futures
  scripts/deploy.sh pga-arb pga-spot-feed
  scripts/deploy.sh --all

Notes:
  - Targeted service deploys are the default and safest option.
  - `--all` is the explicit full-stack path and will include Redis/Postgres.
EOF
}

if [ "$#" -eq 0 ]; then
  usage
  exit 1
fi

if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  usage
  exit 0
fi

declare -a services
if [ "$1" = "--all" ]; then
  if [ "$#" -ne 1 ]; then
    echo "error: --all does not accept additional service arguments" >&2
    echo "" >&2
    usage >&2
    exit 1
  fi
  services=()
  full_stack=true
else
  services=("$@")
  full_stack=false
fi

echo "Starting automated agent deployment..."

# 1. Pull latest code from main.
git pull origin main

# 2. Pre-build prune: free space before parallel image extraction.
# Without this, building many services simultaneously can exhaust disk during
# the containerd layer-unpack phase even when df shows headroom.
docker image prune -f
docker builder prune -f --filter "until=24h"

# 3. Rebuild and restart only the requested services unless the caller
# explicitly opted into a full-stack deploy.
if [ "$full_stack" = true ]; then
  echo "Deploy scope: full stack"
  docker compose up -d --build
else
  echo "Deploy scope: ${services[*]}"
  docker compose up -d --build --no-deps "${services[@]}"
fi

# 4. Post-build cleanup of any newly dangling images and residual cache.
docker image prune -f
docker builder prune -f --filter "until=24h"

echo ""
echo "Deployment complete."
if [ "$full_stack" = true ]; then
  echo "View logs:      docker compose logs -f"
else
  echo "View logs:      docker compose logs -f ${services[*]}"
fi
echo "View status:    docker compose ps"
echo "Dashboard:      npm run monitor:dashboard"
