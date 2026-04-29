# Redis Recovery Runbook

Use this when `redis` enters a restart loop and app workers start logging connection failures such as `getaddrinfo EAI_AGAIN redis` or repeated `max retries per request` errors.

## Symptoms

- `docker compose ps` shows `redis` restarting or unhealthy
- `docker compose logs redis` shows AOF load errors such as:
  - `Bad file format reading the append only file ...`
- `pga-futures`, `pga-arb`, or `pga-db-writer` begin failing Redis operations

## First Principles

- Stop the app stack before touching Redis persistence files.
- Back up `redis-data` before any repair attempt.
- Repair on a copy first, not on the only production copy.
- Bring up `redis` alone and verify it is healthy before starting dependent workers.

## Recovery Steps

### 1. Stop the stack

```bash
docker compose down
```

### 2. Back up the Redis data directory

```bash
sudo -n tar -czf /tmp/redis-data-backup-$(date +%Y%m%dT%H%M%S).tar.gz redis-data
```

### 3. Inspect the AOF set

```bash
sudo -n sh -lc 'ls -lah redis-data redis-data/appendonlydir && cat redis-data/appendonlydir/*.manifest'
```

### 4. Copy the data directory and validate the copy

```bash
sudo -n rm -rf /tmp/redis-repair-work
sudo -n cp -a redis-data /tmp/redis-repair-work
docker run --rm -v /tmp/redis-repair-work:/data redis:alpine \
  sh -lc 'redis-check-aof /data/appendonlydir/appendonly.aof.manifest'
```

### 5. Repair the copied AOF if needed

```bash
docker run --rm -v /tmp/redis-repair-work:/data redis:alpine \
  sh -lc "printf 'y\n' | redis-check-aof --fix /data/appendonlydir/appendonly.aof.manifest"
```

### 6. Validate by starting a disposable Redis instance on the repaired copy

```bash
docker run -d --rm --name redis-repair-test -p 127.0.0.1:6380:6379 \
  -v /tmp/redis-repair-work:/data redis:alpine redis-server --appendonly yes
docker logs redis-repair-test --tail 120
docker run --rm --network host redis:alpine redis-cli -p 6380 ping
docker rm -f redis-repair-test
```

Expected result:

- log reaches `Ready to accept connections`
- `redis-cli` returns `PONG`

### 7. Swap the validated repaired copy into place

```bash
sudo -n mv redis-data redis-data.corrupt-$(date +%Y%m%dT%H%M%S)
sudo -n mv /tmp/redis-repair-work redis-data
sudo -n chown -R "$USER":"$USER" redis-data
```

### 8. Bring up Redis alone

```bash
docker compose up -d redis
docker compose ps redis
docker run --rm --network host redis:alpine redis-cli -p 6379 ping
```

Expected result:

- `redis` is `healthy`
- `PING` returns `PONG`

### 9. Start dependent services without restarting Redis again

```bash
docker compose up -d \
  pga-db pga-db-migrate pga-db-backup pga-bootstrap \
  pga-telegram pga-copytrade pga-monitor pga-futures \
  pga-arb pga-clob-flow pga-sports pga-spot-feed \
  pga-db-writer pga-cron
```

### 10. Run post-restart reconciliation

```bash
npx tsx scripts/reconcile-futures-ledger.ts
```

Expected result:

- `Status: OK`

If mismatches remain, inspect `pga-futures` logs. The monitor backfill/prune pass should usually resolve them automatically within one cycle.

## Operational Guidance

- Do not restart `redis` or `pga-db` for routine app deploys.
- Prefer targeted deploys such as:

```bash
scripts/deploy.sh pga-futures
scripts/deploy.sh pga-arb pga-spot-feed
```

- Reserve `scripts/deploy.sh --all` for intentional full-stack work.

## Hardening Notes

- Redis now has `stop_grace_period: 2m` in Compose to give AOF shutdown more time.
- The host still warns that `vm.overcommit_memory = 1` is not enabled. Set that on the host to reduce persistence fragility during background save/rewrite:

```bash
sudo sysctl vm.overcommit_memory=1
```
