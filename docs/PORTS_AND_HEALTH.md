# Default Ports and Health Endpoints

> **Status:** Normative. This is the single source of truth for all service ports, health endpoints, response formats, and configuration overrides. All other docs MUST reference this document for port/health information.

## 1. Service Port Defaults

| Service | Default Port | Protocol | Env Var | Configurable? |
|---------|-------------|----------|---------|---------------|
| Next.js Web (UI + API) | 3000 | HTTP | `PORT` (Next.js standard) | Yes |
| Redis | 6379 | redis:// | `REDIS_URL` (full URL) | Yes |
| Worker | — (no HTTP) | — | — | N/A |

### 1.1 Web Server Port

**Source:** `packages/web/package.json` — `next dev` / `next start`

The web server uses Next.js default port `3000`. Override via the standard `PORT` env var:

```bash
PORT=8080 pnpm --filter @conductor/web start
```

> **Note:** The root `package.json` has no `start` script. Use `pnpm --filter @conductor/web start` or `cd packages/web && pnpm start`.

### 1.2 Redis

**Source:** `packages/web/src/lib/config.ts`, `packages/worker/src/index.ts`

| Parameter | Default | Env Var |
|-----------|---------|---------|
| URL | `redis://localhost:6379` | `REDIS_URL` |
| TLS | Supported (`rediss://`) | Via URL scheme |

Both web and worker packages read `REDIS_URL` with the same default. URL validation accepts `redis://` and `rediss://` protocols via `validateRedisUrl()` in `packages/shared/src/config/index.ts`.

### 1.3 Worker

The worker is a standalone Node.js process that consumes BullMQ jobs from Redis. It does **not** expose any HTTP endpoints or listen on any port. Communication is exclusively via:
- Redis queues (job consumption)
- SQLite database (shared with web server)
- Redis Pub/Sub (SSE push notifications to web clients)

---

## 2. Health Endpoints

### 2.1 Endpoint Summary

| Endpoint | Type | Status | HTTP Codes | Dependencies Checked |
|----------|------|--------|------------|---------------------|
| `GET /api/health` | Liveness | Implemented | 200, 500 | None (but config load can fail) |
| `GET /api/health/redis` | Readiness | Implemented | 200, 503 | Bootstrap (DB + queue) + Redis |
| `GET /api/health/db` | Readiness | Planned | — | SQLite |
| `GET /api/health/deep` | Readiness | Planned | — | Redis + SQLite |

### 2.2 Liveness: `GET /api/health`

**Source:** `packages/web/src/app/api/health/route.ts`

Returns 200 if the web process is alive and configuration loads successfully.

**Response (200 OK):**

```json
{
  "data": {
    "status": "ok",
    "timestamp": "2026-02-20T12:34:56.789Z",
    "version": "0.1.0",
    "environment": "production"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.status` | `"ok"` | Always `"ok"` when responding successfully |
| `data.timestamp` | ISO 8601 | Server time |
| `data.version` | Semver | From `process.env['npm_package_version']` with fallback to `'0.1.0'` |
| `data.environment` | `"development"` \| `"production"` \| `"test"` | From `NODE_ENV` |

> **Caveat:** This endpoint calls `getConfig()`, which validates env vars. If configuration is invalid (e.g., malformed `REDIS_URL`), the route may return 500 instead of 200. For a pure liveness check, this coupling should be removed in a future version.

**Config:** `export const dynamic = 'force-dynamic'` ensures no caching.

**Usage:** Docker Compose health checks, load balancer liveness probes, uptime monitoring.

### 2.3 Readiness: `GET /api/health/redis`

**Source:** `packages/web/src/app/api/health/redis/route.ts`

Checks Redis connectivity via `checkHealth()` from `@/lib/bootstrap`. This internally calls `ensureBootstrap()`, which initializes the database and queue manager — so this endpoint validates the full bootstrap chain, not just Redis.

**Response (200 OK):**

```json
{
  "data": {
    "status": "ok",
    "latencyMs": 2
  }
}
```

**Response (503 Service Unavailable):**

```json
{
  "error": "Redis health check failed: Connection refused",
  "code": "SERVICE_UNAVAILABLE"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.latencyMs` | number | Redis PING round-trip time in milliseconds |

> **Note:** Because `checkHealth()` runs through `ensureBootstrap()`, failures in DB initialization or queue manager setup will also trigger a 503 from this endpoint. This makes it a broader readiness check than the name implies.

**Usage:** Pre-deployment readiness gates, dependency monitoring.

### 2.4 Planned: `GET /api/health/db` (Not Implemented)

Will check SQLite connectivity and schema version.

### 2.5 Planned: `GET /api/health/deep` (Not Implemented)

Will combine Redis + SQLite checks. Returns 503 if **any** dependency fails.

---

## 3. Health Check Response Format

### 3.1 Success Shape

All health endpoints use the `success()` helper from `packages/web/src/lib/api-utils.ts`, which wraps the payload in a `data` envelope:

```json
{
  "data": {
    "status": "ok",
    ...endpoint-specific fields
  }
}
```

### 3.2 Error Shape

Health endpoints that check dependencies use the standard `ApiError` format:

```json
{
  "error": "<human-readable message>",
  "code": "<error code>",
  "details": ...optional
}
```

The `errors.serviceUnavailable()` helper returns 503 with code `SERVICE_UNAVAILABLE`.

### 3.3 Readiness vs Liveness

| Check Type | Purpose | Failing Behavior | Example |
|-----------|---------|------------------|---------|
| **Liveness** | "Is the process alive?" | Restart the container | `GET /api/health` |
| **Readiness** | "Can it serve requests?" | Remove from load balancer | `GET /api/health/redis` |

Liveness checks should not depend on external services — a Redis outage should not trigger web server restarts. The current `/api/health` endpoint has a config-loading dependency that should be removed for purity (see § 2.2 caveat).

---

## 4. Docker Compose Health Configuration

### 4.1 Current `docker-compose.yml`

The repository's `docker-compose.yml` defines only the Redis service (used for local development):

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 3
```

No web or worker services are defined in the current compose file — they are started separately via `pnpm dev:web` and `pnpm dev:worker`.

### 4.2 Production Compose (Example)

For production deployments, a separate compose manifest would include web and worker services. See `docs/DEPLOYMENT.md` § 2 for the recommended production manifest with health check configurations:

```yaml
# Example — not in current docker-compose.yml
conductor:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 10s
```

---

## 5. Reverse Proxy Health Integration (Examples)

> **Note:** No reverse proxy configuration files are tracked in the repository. These are example configurations for reference.

### 5.1 Caddy (Example)

```
reverse_proxy conductor:3000 {
    health_uri /api/health
    health_interval 30s
    health_timeout 5s
}
```

### 5.2 Nginx (Example)

```nginx
upstream conductor {
    server 127.0.0.1:3000;
}

location /api/health {
    proxy_pass http://conductor;
    proxy_connect_timeout 5s;
    proxy_read_timeout 5s;
}
```

---

## 6. Base URL Construction

### 6.1 Internal URLs

| Context | URL Pattern |
|---------|-------------|
| Web ↔ Redis | `${REDIS_URL}` (default `redis://localhost:6379`) |
| Worker ↔ Redis | `${REDIS_URL}` (default `redis://localhost:6379`) |
| Web ↔ SQLite | `${DATABASE_PATH}` (default `./conductor.db`) |
| Worker ↔ SQLite | `${DATABASE_PATH}` (default `./conductor.db`) |

### 6.2 External URLs

| Context | URL Pattern | Configuration |
|---------|-------------|---------------|
| GitHub webhook callback | `https://<public-domain>/api/webhooks/github` | GitHub App settings |
| GitHub OAuth callback | `https://<public-domain>/api/auth/github/callback` | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` |
| Web UI | `https://<public-domain>` | Reverse proxy |

---

## 7. Port Override Reference

### 7.1 All Port-Related Environment Variables

| Variable | Default | Affects | Description |
|----------|---------|---------|-------------|
| `PORT` | 3000 | Web server | Next.js standard port override |
| `REDIS_URL` | `redis://localhost:6379` | Web + Worker | Full Redis connection URL (includes port) |
| `CONDUCTOR_PORT_RANGE` | `3100-3199` | Worktree dev servers | Port range for worktree port allocation (`packages/shared/src/worktree/index.ts`) |

### 7.2 Port Conflict Prevention

In development, the default ports are:
- Web: 3000
- Redis: 6379
- Worktree dev servers: 3100–3199

If port 3000 is occupied, override with `PORT=3001 pnpm --filter @conductor/web dev`.

---

## 8. Worker Health Observability

Since the worker has no HTTP endpoint, health is observed through:

| Signal | Mechanism | Healthy Indicator |
|--------|-----------|-------------------|
| Process status | Docker Compose `restart: unless-stopped` | Process running |
| Queue consumption | BullMQ active job count | Jobs being processed |
| Redis connectivity | Worker logs on startup | Successful connection |
| Job completion | `removeOnComplete` counts in Redis | Jobs completing normally |

> **Future enhancement:** Add a lightweight HTTP server to the worker for Kubernetes liveness/readiness probes.

---

## 9. Cross-References

| Topic | Document |
|-------|----------|
| Full deployment configuration | `docs/DEPLOYMENT.md` |
| Observability and metrics | `docs/OBSERVABILITY.md` |
| Rate limiting and provider health | `docs/RATE_LIMITING.md` |
| Production Docker Compose manifest | `docs/DEPLOYMENT.md` § 2 |
| Reverse proxy configuration | `docs/DEPLOYMENT.md` § 4 |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-20
**Reviewer:** Codex (read-only sandbox)
**Findings:** 16 total — 10 BLOCKING, 1 HIGH, 5 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §2.2 Health response | Response wrapped in `{ data: ... }` envelope | Fixed all response examples to show `data` wrapper |
| 2 | BLOCKING | §2.3 Redis health | Also uses `{ data: ... }` envelope | Fixed response example |
| 3 | BLOCKING | §2.3 Error shape | Error is top-level `{ error, code }`, not nested | Fixed 503 response example to match `ApiError` interface |
| 4 | BLOCKING | §3.1 Success shape | Success uses `success()` envelope | Documented `data` envelope pattern |
| 5 | BLOCKING | §2.1/§2.3 | Redis health also runs bootstrap (DB + queue), not just Redis | Added note about bootstrap coupling |
| 6 | BLOCKING | §2.1/§2.2 | Liveness can return 500 on config validation | Added 500 to HTTP codes and caveat about config loading |
| 7 | BLOCKING | §4.1 Docker Compose | Web healthcheck not in actual `docker-compose.yml` (only Redis) | Rewrote to show actual compose content; moved web example to §4.2 |
| 8 | BLOCKING | §4.2 Redis health | Interval is 5s, not 10s | Fixed to match actual compose |
| 9 | BLOCKING | §4.3 Worker | No worker service in current compose | Removed worker compose section; noted separate process startup |
| 10 | BLOCKING | §7.1 CONDUCTOR_PORT | Not in actual compose file | Removed; only documented `PORT` (Next.js standard) |
| 11 | BLOCKING | §6.1 Docker internal | No `conductor` service in compose | Removed Docker internal URL reference |
| 12 | HIGH | §5 Reverse proxy | No tracked config files in repo | Added "Example" labels throughout |
| 13 | MEDIUM | §7.1 Port vars | Missing `CONDUCTOR_PORT_RANGE` | Added worktree port range variable |
| 14 | MEDIUM | §1.1 Command | Root has no `start` script | Fixed to `pnpm --filter @conductor/web start` |
| 15 | MEDIUM | §2.2 Version | From `npm_package_version` env, not file read | Corrected source description |
| 16 | BLOCKING | Appendix A | Claimed all verified but had mismatches | Replaced with accurate resolution table |
