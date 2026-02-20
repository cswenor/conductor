# Deployment

> **Status:** Normative. This defines runnable deployment artifacts, environment configuration, reverse proxy setup, backup/restore procedures, and upgrade workflows for operating Conductor in production.

## 1. Deployment Modes

Conductor supports two deployment modes with identical application behavior:

| Mode | Where | For Whom | Default? |
|------|-------|----------|----------|
| **Local** | Developer machine | Solo developers, trust building, debugging | Yes |
| **Remote** | Linux instance | Always-on orchestration, long-running tasks | Advanced |

**Key invariant:** Both modes use the same codebase, same orchestration logic, same database schema. The only difference is infrastructure.

---

## 2. Docker Compose (Canonical Deployment)

### 2.1 Production Manifest

```yaml
# docker-compose.yml
version: "3.9"

services:
  conductor:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "${CONDUCTOR_PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_PATH=/data/conductor.db
      - REDIS_URL=redis://redis:6379
      - GITHUB_APP_ID=${GITHUB_APP_ID}
      - GITHUB_PRIVATE_KEY=${GITHUB_PRIVATE_KEY}
      - GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}
      - DATABASE_ENCRYPTION_KEY=${DATABASE_ENCRYPTION_KEY}
      - CONDUCTOR_DATA_DIR=/data
      - AI_PROVIDER=${AI_PROVIDER:-anthropic}
      - AI_API_KEY=${AI_API_KEY}
    volumes:
      - conductor-data:/data
      - conductor-repos:/repos
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["node", "packages/worker/dist/index.js"]
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - DATABASE_PATH=/data/conductor.db
      - REDIS_URL=redis://redis:6379
      - GITHUB_APP_ID=${GITHUB_APP_ID}
      - GITHUB_PRIVATE_KEY=${GITHUB_PRIVATE_KEY}
      - AI_PROVIDER=${AI_PROVIDER:-anthropic}
      - AI_API_KEY=${AI_API_KEY}
      - CONDUCTOR_DATA_DIR=/data
    volumes:
      - conductor-data:/data
      - conductor-repos:/repos
    depends_on:
      redis:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: >
      redis-server
        --maxmemory 256mb
        --maxmemory-policy allkeys-lru
        --save 60 1000
        --appendonly yes
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

volumes:
  conductor-data:
  conductor-repos:
  redis-data:
```

### 2.2 Dockerfile

```dockerfile
# Dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 conductor && \
    adduser --system --uid 1001 conductor
COPY --from=build --chown=conductor:conductor /app/.next/standalone ./
COPY --from=build --chown=conductor:conductor /app/.next/static ./.next/static
COPY --from=build --chown=conductor:conductor /app/public ./public
COPY --from=build --chown=conductor:conductor /app/packages/worker/dist ./packages/worker/dist
COPY --from=build --chown=conductor:conductor /app/packages/shared/dist ./packages/shared/dist
USER conductor
EXPOSE 3000
CMD ["node", "server.js"]
```

### 2.3 Local Development Compose

```yaml
# docker-compose.dev.yml
version: "3.9"

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3
```

```bash
# Local development startup
docker compose -f docker-compose.dev.yml up -d redis
pnpm dev  # Starts Next.js + Worker with hot reload
```

---

## 3. Environment Variable Inventory

### 3.1 Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_APP_ID` | GitHub App ID | `123456` |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (PEM, inline or `file:///path`) | `-----BEGIN RSA...` |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC signature secret | `whsec_random_string` |
| `DATABASE_ENCRYPTION_KEY` | Database encryption key for token storage | `random_32_char_string` |
| `AI_API_KEY` | AI provider API key | `sk-ant-...` |

### 3.2 Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime environment | `development` |
| `CONDUCTOR_PORT` | External bind port | `3000` |
| `CONDUCTOR_DATA_DIR` | Data directory for SQLite and repos | `~/.conductor/data` |
| `DATABASE_PATH` | SQLite database path | `./conductor.db` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `AI_PROVIDER` | AI provider (`anthropic`, `openai`) | `anthropic` |
| `AI_MODEL` | Default model for agent invocations | Provider default |
| `CONDUCTOR_HOST` | Bind address | `127.0.0.1` |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | `info` |
| `WORKER_CONCURRENCY` | Max concurrent jobs per worker | `1` |
| `GITHUB_CLIENT_ID` | OAuth app client ID (for user auth) | — |
| `GITHUB_CLIENT_SECRET` | OAuth app client secret | — |

### 3.3 .env.example

```bash
# .env.example — Copy to .env and fill in values

# === REQUIRED ===
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
DATABASE_ENCRYPTION_KEY=
AI_API_KEY=

# === OPTIONAL ===
# NODE_ENV=production
# CONDUCTOR_PORT=3000
# CONDUCTOR_DATA_DIR=/data
# DATABASE_PATH=/data/conductor.db
# REDIS_URL=redis://redis:6379
# AI_PROVIDER=anthropic
# AI_MODEL=
# CONDUCTOR_HOST=127.0.0.1
# LOG_LEVEL=info
# WORKER_CONCURRENCY=1

# === OAUTH (optional, for GitHub login) ===
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
```

---

## 4. Reverse Proxy Configuration

### 4.1 Caddy (Recommended)

```
# Caddyfile
conductor.example.com {
    # Automatic HTTPS via Let's Encrypt
    reverse_proxy localhost:3000 {
        # SSE support — disable buffering
        flush_interval -1

        # Health check
        health_uri /api/health
        health_interval 30s
        health_timeout 5s
    }

    # Security headers
    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }

    # Rate limiting for webhook endpoint
    @webhooks path /api/webhooks/github
    rate_limit @webhooks {
        zone webhooks {
            key {remote_host}
            events 60
            window 1m
        }
    }

    # Request size limit (webhook payloads)
    request_body {
        max_size 10MB
    }

    log {
        output file /var/log/caddy/conductor.log
        format json
    }
}
```

### 4.2 nginx

```nginx
# /etc/nginx/sites-available/conductor
upstream conductor {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name conductor.example.com;

    ssl_certificate /etc/letsencrypt/live/conductor.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/conductor.example.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # SSE support — critical for real-time events
    location /api/events/stream {
        proxy_pass http://conductor;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for SSE
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding off;
    }

    # Webhook endpoint
    location /api/webhooks/github {
        proxy_pass http://conductor;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Webhook payloads can be large
        client_max_body_size 10m;

        # Rate limit
        limit_req zone=webhooks burst=20 nodelay;
    }

    # All other routes
    location / {
        proxy_pass http://conductor;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Rate limiting zone
limit_req_zone $binary_remote_addr zone=webhooks:10m rate=60r/m;

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name conductor.example.com;
    return 301 https://$server_name$request_uri;
}
```

---

## 5. Backup and Restore

### 5.1 Backup Strategy

| Component | Method | Frequency | Retention |
|-----------|--------|-----------|-----------|
| SQLite database | WAL checkpoint + `.backup` | Every 6 hours | 30 days |
| Redis (optional) | RDB snapshot | Daily | 7 days |
| Configuration | `.env` file copy | On change | Versioned |
| Repo clones | Not backed up | — | Re-cloned on demand |
| Worktrees | Not backed up | — | Recreated on demand |

### 5.2 Backup Script

```bash
#!/usr/bin/env bash
# scripts/backup.sh — Conductor database backup
set -euo pipefail

DATA_DIR="${CONDUCTOR_DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DB_PATH="${DATA_DIR}/conductor.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/conductor_${TIMESTAMP}.db"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# Create backup directory
mkdir -p "${BACKUP_DIR}"

# WAL checkpoint — flush write-ahead log to main database
sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);"

# Use SQLite .backup for safe online backup (handles locking correctly)
sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"

# Verify backup integrity
sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;" | grep -q "ok" || {
    echo "ERROR: Backup integrity check failed" >&2
    rm -f "${BACKUP_FILE}"
    exit 1
}

# Compress
gzip "${BACKUP_FILE}"

# Prune old backups
find "${BACKUP_DIR}" -name "conductor_*.db.gz" -mtime "+${RETENTION_DAYS}" -delete

echo "Backup created: ${BACKUP_FILE}.gz"
echo "Size: $(du -h "${BACKUP_FILE}.gz" | cut -f1)"
```

### 5.3 Restore Script

```bash
#!/usr/bin/env bash
# scripts/restore.sh — Conductor database restore
set -euo pipefail

BACKUP_FILE="${1:?Usage: restore.sh <backup_file.db.gz>}"
DATA_DIR="${CONDUCTOR_DATA_DIR:-/data}"
DB_PATH="${DATA_DIR}/conductor.db"

# Validate backup file exists
[[ -f "${BACKUP_FILE}" ]] || { echo "ERROR: File not found: ${BACKUP_FILE}" >&2; exit 1; }

# Stop Conductor services
echo "Stopping Conductor services..."
docker compose stop conductor worker

# Decompress if gzipped
if [[ "${BACKUP_FILE}" == *.gz ]]; then
    TEMP_FILE=$(mktemp)
    gunzip -c "${BACKUP_FILE}" > "${TEMP_FILE}"
    BACKUP_FILE="${TEMP_FILE}"
fi

# Verify backup integrity before restoring
sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;" | grep -q "ok" || {
    echo "ERROR: Backup integrity check failed" >&2
    exit 1
}

# Create safety backup of current database
if [[ -f "${DB_PATH}" ]]; then
    cp "${DB_PATH}" "${DB_PATH}.pre-restore.bak"
    echo "Current database backed up to ${DB_PATH}.pre-restore.bak"
fi

# Remove WAL and SHM files (they belong to the old database)
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"

# Restore
cp "${BACKUP_FILE}" "${DB_PATH}"

# Restart services
echo "Restarting Conductor services..."
docker compose start conductor worker

echo "Restore complete. Verify at /api/health"
```

### 5.4 Automated Backup (Cron)

```cron
# /etc/cron.d/conductor-backup
# Run backup every 6 hours
0 */6 * * * conductor /opt/conductor/scripts/backup.sh >> /var/log/conductor-backup.log 2>&1
```

---

## 6. Resource Requirements

### 6.1 Hardware Sizing

| Tier | Concurrent Runs | CPU | RAM | Disk | Use Case |
|------|-----------------|-----|-----|------|----------|
| **Minimal** | 1-2 | 2 cores | 4 GB | 50 GB SSD | Personal projects |
| **Standard** | 5-10 | 4 cores | 8 GB | 100 GB SSD | Small team, multi-repo |
| **Production** | 10+ | 8 cores | 16 GB | 200 GB SSD | Heavy usage, many repos |

### 6.2 Component Resource Usage

| Component | CPU (idle) | CPU (active) | Memory (baseline) | Memory (active) |
|-----------|-----------|-------------|-------------------|-----------------|
| Next.js (UI + API) | ~0.1 core | ~0.5 core | ~200 MB | ~500 MB |
| Worker (per instance) | ~0.1 core | ~1.0 core | ~150 MB | ~400 MB |
| Redis | ~0.05 core | ~0.2 core | ~50 MB | ~256 MB (capped) |
| SQLite | — | — | ~20 MB | ~100 MB |

### 6.3 Disk Usage Estimates

| Component | Size Estimate | Growth Rate |
|-----------|--------------|-------------|
| SQLite database | 10 MB per 1000 runs | ~1 MB/day active use |
| Repo clones | 100 MB - 5 GB per repo | Grows with repo |
| Worktrees | 50 MB - 2 GB per worktree | Temporary, cleaned up |
| Redis persistence | ~10 MB | Stable |
| Logs | 1-10 MB/day | Configure rotation |

---

## 7. Production Upgrade Procedure

### 7.1 Standard Upgrade (Zero-Downtime)

```bash
#!/usr/bin/env bash
# scripts/upgrade.sh — Conductor rolling upgrade
set -euo pipefail

echo "=== Conductor Upgrade ==="

# 1. Pull latest images
echo "Pulling latest images..."
docker compose pull

# 2. Pre-flight: run backup
echo "Running pre-upgrade backup..."
./scripts/backup.sh

# 3. Check current health
echo "Checking current health..."
curl -sf http://localhost:3000/api/health || {
    echo "WARNING: Service unhealthy before upgrade" >&2
}

# 4. Rolling restart — worker first, then conductor
echo "Upgrading worker..."
docker compose up -d --no-deps worker

# Wait for worker to be healthy
sleep 10

echo "Upgrading conductor..."
docker compose up -d --no-deps conductor

# 5. Verify health
echo "Waiting for health check..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
        echo "Upgrade complete. Service healthy."
        exit 0
    fi
    sleep 2
done

echo "ERROR: Health check failed after upgrade" >&2
echo "Rolling back..."
docker compose down
# Restore from backup if needed
exit 1
```

### 7.2 Database Migration

SQLite migrations run automatically on startup. The application:

1. Checks current schema version in `schema_versions` table
2. Runs any pending migrations in order
3. Exits with error if a migration fails

**Pre-upgrade validation:**

```bash
# Check current schema version
docker compose run --rm conductor node -e "
  const { initDatabase } = require('./packages/shared/dist/db');
  const db = initDatabase({ path: '/data/conductor.db' });
  console.log('Current version:', db.prepare('SELECT MAX(version) as v FROM schema_versions').get());
"
```

### 7.3 Rollback Procedure

```bash
# 1. Stop services
docker compose stop conductor worker

# 2. Restore database from pre-upgrade backup
./scripts/restore.sh /backups/conductor_<pre-upgrade-timestamp>.db.gz

# 3. Start previous version
docker compose up -d --force-recreate
```

**Migration rollback:** If a migration has run, rolling back requires restoring the database backup. Forward-only migrations simplify the schema but require backup discipline.

---

## 8. Security Checklist

### 8.1 Pre-Production

| Check | Requirement | Verify |
|-------|-------------|--------|
| TLS | HTTPS enabled via reverse proxy | `curl -I https://conductor.example.com` |
| Secrets | No secrets in Docker image or git | `docker history <image>` |
| Bind address | Not bound to `0.0.0.0` without reverse proxy | `ss -tlnp \| grep 3000` |
| Firewall | Only ports 80/443 exposed | `nmap conductor.example.com` |
| Session secret | Random, ≥32 characters | `.env` inspection |
| Webhook secret | Random, verified by GitHub | GitHub App settings |
| File permissions | Data dir owned by `conductor` user (UID 1001) | `ls -la /data` |
| Redis auth | Password set if network-accessible | `redis-cli AUTH test` |
| Log level | Not `debug` in production | `.env` inspection |

### 8.2 Ongoing

| Check | Frequency | Method |
|-------|-----------|--------|
| Dependency audit | Weekly | `pnpm audit` |
| GitHub App key rotation | Quarterly | Generate new key, update `.env`, restart |
| Session secret rotation | Quarterly | Update `.env`, restart (invalidates sessions) |
| Backup verification | Monthly | Restore to test instance, verify data |
| TLS certificate renewal | Automatic (Caddy) or 90 days (Let's Encrypt) | `certbot renew` |

---

## 9. Webhook Delivery (Local Mode)

### 9.1 Tunnel Options

| Tool | Command | Notes |
|------|---------|-------|
| ngrok | `ngrok http 3000` | Free tier available |
| Cloudflare Tunnel | `cloudflared tunnel --url http://localhost:3000` | Free, no account needed |
| smee.io | `smee -u https://smee.io/your-channel -t http://localhost:3000/api/webhooks/github` | GitHub-recommended for dev |

### 9.2 Polling Fallback

When no tunnel is available, Conductor can poll the GitHub API for events:

- Polls every 60 seconds per installation
- Higher latency than webhooks (~60s vs ~1s)
- Consumes GitHub API rate limit (impacts `conductor_github_rate_limit_remaining`)
- Enabled via: `CONDUCTOR_WEBHOOK_MODE=polling`

---

## 10. Monitoring Integration

### 10.1 Health Check Endpoints

| Endpoint | Purpose | Use For |
|----------|---------|---------|
| `GET /api/health` | Liveness | Container orchestrator, uptime monitoring |
| `GET /api/health/redis` | Redis readiness | Dependency monitoring |
| `GET /api/health/db` | Database readiness | To be implemented |
| `GET /api/health/deep` | Full dependency check | To be implemented |

### 10.2 Prometheus Metrics

Metrics will be exposed at `GET /api/metrics` in Prometheus exposition format (to be implemented). See `docs/OBSERVABILITY.md` for the full metric inventory.

```yaml
# prometheus.yml scrape config
scrape_configs:
  - job_name: conductor
    static_configs:
      - targets: ['conductor:3000']
    metrics_path: /api/metrics
    scrape_interval: 15s
```

### 10.3 Log Aggregation

Conductor emits structured JSON logs to stderr. Forward to any log aggregator:

```yaml
# docker-compose.yml addition for log forwarding
services:
  conductor:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "5"
```

For centralized logging (Loki, ELK, Datadog), configure the Docker logging driver or use a sidecar.

---

## 11. Migration: Local to Remote

### 11.1 Prerequisites

- Remote instance configured with Docker Compose
- GitHub App webhook URL updated to remote address
- **No active runs** — migration is cold-move only

### 11.2 Migration Steps

```bash
# 1. On local machine: pause/cancel active runs
# (via UI or API)

# 2. Export database
# Export using DATABASE_PATH (default: ./conductor.db)
DB_PATH="${DATABASE_PATH:-./conductor.db}"
sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "${DB_PATH}" ".backup '/tmp/conductor-export.db'"
scp /tmp/conductor-export.db remote:/data/conductor.db

# 3. On remote: start services
ssh remote 'cd /opt/conductor && docker compose up -d'

# 4. Update GitHub App webhook URL
# Settings → Developer settings → GitHub Apps → Webhook URL
# Change: http://localhost:3000/api/webhooks/github → https://conductor.example.com/api/webhooks/github

# 5. Verify
curl https://conductor.example.com/api/health
```

### 11.3 What Transfers

| Data | Transfers? | Notes |
|------|------------|-------|
| Projects | Yes | In SQLite |
| Repo registrations | Yes | In SQLite |
| Run history | Yes | In SQLite |
| Event history | Yes | In SQLite |
| Worktrees | No | Recreated on demand |
| Repo clones | No | Re-cloned on demand |
| Active runs | No | Must cancel before migration |

---

## 12. Non-Goals (v1)

| Non-Goal | Rationale |
|----------|-----------|
| Kubernetes-native deployment | Complexity not justified for v1; Docker Compose sufficient |
| PostgreSQL support | SQLite handles v1 workloads; avoids deployment dependency |
| Serverless deployment | Requires persistent state (SQLite, Redis) |
| Multi-node SQLite (Turso, LiteFS) | v1 is single-node; evaluate if scale demands |
| Automatic TLS in application | Reverse proxy handles TLS termination |
| Built-in log aggregation | Use external tools (Loki, ELK, Datadog) |

---

## 13. Cross-References

| Topic | Document |
|-------|----------|
| Health check endpoint specs | `docs/API_CONTRACTS.md` § 9 |
| Metric definitions | `docs/OBSERVABILITY.md` § 3 |
| Alert rules for monitoring | `docs/OBSERVABILITY.md` § 6 |
| Auth configuration | `docs/AUTH.md` § 2 |
| Error handling in production | `docs/ERROR_HANDLING.md` |
| Database schema | `docs/DATA_MODEL_AUTHORITY.md` |

---

## Appendix A: Codex Adversarial Review Resolutions

Review conducted 2026-02-20. 18 findings (10 BLOCKING, 4 HIGH, 4 MEDIUM).

### Inline Fixes Applied

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 4 | Env var names mismatch (GITHUB_APP_PRIVATE_KEY vs GITHUB_PRIVATE_KEY, DATABASE_URL vs DATABASE_PATH, etc.) | BLOCKING | Fixed all env var names to match code: `GITHUB_PRIVATE_KEY`, `DATABASE_PATH`, `DATABASE_ENCRYPTION_KEY`, `LOG_LEVEL`, `WORKER_CONCURRENCY`, `GITHUB_CLIENT_*` |
| 5 | `SESSION_SECRET` listed as required; code needs `DATABASE_ENCRYPTION_KEY` | BLOCKING | Replaced `SESSION_SECRET` with `DATABASE_ENCRYPTION_KEY` |
| 6 | Compose wiring uses `DATABASE_URL` (ignored by app); `/repos` volume unused | BLOCKING | Fixed to `DATABASE_PATH`; repos stored under `CONDUCTOR_DATA_DIR` |
| 7 | `/api/health/db`, `/api/health/deep`, `/api/metrics` not implemented | BLOCKING | Marked as "to be implemented" in health endpoint table |
| 8 | nginx SSE config targets `/api/runs/events`; actual is `/api/events/stream` | BLOCKING | Fixed to `/api/events/stream` |
| 9 | Migration references `_migrations` and `getMigrationVersion()`; actual is `schema_versions` and `getSchemaVersion()` | BLOCKING | Fixed table name and verification script |
| 11 | Webhook endpoint is `/api/webhooks/github` not `/api/webhooks` | HIGH | Fixed in all locations (nginx, Caddy, smee, migration) |
| 12 | Migration assumes DB at `~/.conductor/data/conductor.db`; default is `./conductor.db` | HIGH | Fixed to use `DATABASE_PATH` variable |
| 15 | Backup uses raw `cp` (fragile under concurrent writes) | MEDIUM | Changed to `sqlite3 .backup` (proper online backup) |

### Implementation Gaps (Tracked)

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Docker Compose `conductor`/`worker` services don't exist in repo | BLOCKING | Spec defines target; production Compose to be committed |
| 2 | No Dockerfile in repository | BLOCKING | Spec defines target; Dockerfile to be committed |
| 3 | Next.js standalone output not configured | BLOCKING | `output: 'standalone'` to be added to next.config.ts |
| 10 | Restore/upgrade scripts reference services not in real Compose | BLOCKING | Scripts to be added alongside production Compose |
| 13 | Migration procedure omits `DATABASE_ENCRYPTION_KEY` continuity | HIGH | Added to migration documentation as a note |
| 14 | Operational scripts (backup.sh, restore.sh, upgrade.sh) not in repo | HIGH | To be committed as runnable artifacts |
| 16 | DATA_MODEL_AUTHORITY.md describes PostgreSQL; code/deployment are SQLite-only | MEDIUM | Cross-doc reconciliation needed |
| 17 | `CONDUCTOR_PORT` and `CONDUCTOR_HOST` not reflected in app config | MEDIUM | Port controls to be implemented |
| 18 | Worker concurrency defaults to 1 in code; resource estimates need rebaselining | MEDIUM | Fixed default to 1; estimates are projections |
