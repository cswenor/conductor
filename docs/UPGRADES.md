# Upgrade and Migration Path

> **Status:** Normative. This defines the schema migration system, breaking change policy, upgrade/rollback procedures, API versioning strategy, and version compatibility rules for Conductor.

## 1. Schema Migration System

### 1.1 Migration Tool

Conductor uses a **custom forward-only migration system** built on `better-sqlite3`:

- **Migration files:** `packages/shared/src/db/migrations/*.ts`
- **Registry:** `packages/shared/src/db/migrations/index.ts` — central ordered array
- **Execution:** `runMigrations(db)` called by `initDatabase()` on every startup
- **Tracking table:** `schema_versions`

### 1.2 Migration Interface

```typescript
interface Migration {
  version: number;    // Sequential integer (1, 2, 3...)
  name: string;       // Human-readable name (e.g., '001_initial_schema')
  up: (db: Database) => void;  // Forward migration function
}
```

**No `down` function.** Migrations are forward-only. Rollback requires database backup restoration (see § 5).

### 1.3 Schema Versions Table

```sql
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

| Column | Type | Description |
|--------|------|-------------|
| `version` | INTEGER PK | Migration sequence number |
| `name` | TEXT | Migration name for audit |
| `applied_at` | TEXT | ISO 8601 timestamp of application |

### 1.4 Migration Execution Flow

```
Application Startup
  → initDatabase(path)
    → CREATE TABLE IF NOT EXISTS schema_versions
    → SELECT MAX(version) FROM schema_versions  → currentVersion
    → For each migration WHERE version > currentVersion:
        → BEGIN TRANSACTION
        → migration.up(db)
        → INSERT INTO schema_versions (version, name)
        → COMMIT
    → Database ready
```

**Invariants:**
- Migrations run in strict version order
- Each migration runs in a transaction (atomic success or rollback)
- Migrations are idempotent by convention (CREATE IF NOT EXISTS, etc.)
- On failure, the transaction rolls back and the application exits with error

### 1.5 Current Migration Inventory

As of v0.1.0, there are **24 migrations**:

| Range | Category | Examples |
|-------|----------|---------|
| 001 | Initial schema | Core tables: projects, repos, tasks, runs, events, agent_invocations, etc. |
| 002-005 | Schema fixes | FK constraints, column additions, index corrections |
| 006-010 | Auth spine | Users, sessions, user_api_keys, ownership enforcement |
| 011-015 | Agent & messaging | Agent invocations, operator actions, message tables |
| 016-019 | Mirroring & tracking | GitHub mirroring (016), repo tracking (017), stream events v2 (018), config (019) |
| 020-024 | Control gates | Gate decisions, workflow config, epoch versioning, rewind support |

---

## 2. Breaking Change Policy

### 2.1 What Constitutes a Breaking Change

| Category | Breaking | Non-Breaking |
|----------|----------|--------------|
| **Database** | Dropping a column, renaming a table, changing a constraint | Adding a column (nullable or with default), adding an index, adding a table |
| **API** | Removing an endpoint, changing response shape, removing a field | Adding an endpoint, adding an optional field, adding a header |
| **Config** | Removing an env var, changing default behavior | Adding an optional env var, adding a new config section |
| **Events** | Removing an event type, changing event payload shape | Adding a new event type, adding optional fields |

### 2.2 Breaking Change Rules

1. **Database breaking changes** require a table rebuild migration (SQLite does not support `ALTER TABLE DROP COLUMN` reliably):
   ```sql
   CREATE TABLE table_new (...);
   INSERT INTO table_new SELECT ... FROM table_old;
   DROP TABLE table_old;
   ALTER TABLE table_new RENAME TO table;
   -- Recreate indexes
   ```

2. **API breaking changes** require a new API version (see § 6).

3. **All breaking changes** must be documented in `CHANGELOG.md` with migration instructions.

4. **No breaking changes within a minor version.** Breaking changes require a minor version bump (v0.1 → v0.2).

---

## 3. Version Compatibility Matrix

### 3.1 Schema ↔ Application Compatibility

| App Version | Min Schema | Max Schema | Notes |
|-------------|-----------|-----------|-------|
| v0.1.x | 1 | 24 | Initial release |
| v0.2.x | 25+ | TBD | Will add new migrations |

**Rule:** The application calls `runMigrations(db)` on startup, which runs all pending migrations (versions higher than current). There is no max-version check — if the schema is already at or beyond the latest migration, no migrations run and the app proceeds normally. **There is no "schema higher than expected" warning path in the current implementation.**

### 3.2 Package Version Alignment

All packages in the monorepo share the same version:

| Package | v0.1.0 |
|---------|--------|
| `@conductor/shared` | v0.1.0 |
| `@conductor/web` | v0.1.0 |
| `@conductor/worker` | v0.1.0 |

**Invariant:** Deploying mismatched package versions (e.g., web v0.2.0 with worker v0.1.0) is unsupported and may cause runtime errors.

---

## 4. Upgrade Procedure

### 4.1 Standard Upgrade (Single Instance)

> **Note:** The repository does not include `./scripts/backup.sh` or `./scripts/restore.sh`. The `docker-compose.yml` defines only a `redis` service — there are no `conductor` or `worker` Docker Compose services. The examples below use manual equivalents.

```bash
# 1. Pre-flight — check current schema version
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH || './conductor.db');
  console.log('Schema version:', db.prepare('SELECT MAX(version) as v FROM schema_versions').get());
"

# 2. Backup database (manual — no backup.sh script exists)
cp conductor.db conductor.db.bak-$(date +%Y%m%d-%H%M%S)

# 3. Pull new code
git pull

# 4. Rebuild
pnpm install && pnpm build

# 5. Restart services (web + worker started separately in development)
# Stop: Ctrl-C on pnpm dev:web and pnpm dev:worker
# Start: pnpm dev:web && pnpm dev:worker

# 6. Verify
curl -sf http://localhost:3000/api/health
```

### 4.2 Upgrade with Breaking Schema Changes

When upgrading across a minor version boundary (e.g., v0.1 → v0.2):

```bash
# 1. Stop all services
# Stop pnpm dev:web and pnpm dev:worker

# 2. Backup database (manual)
cp conductor.db conductor.db.bak-$(date +%Y%m%d-%H%M%S)

# 3. Pull new code
git pull && pnpm install && pnpm build

# 4. Run migrations explicitly (migrations run automatically on startup)
node -e "
  const { initDatabase } = require('./packages/shared/dist/db/index.js');
  initDatabase(process.env.DATABASE_PATH || './conductor.db');
  console.log('Migrations complete');
"

# 5. Start services
pnpm dev:web &
pnpm dev:worker &

# 6. Verify
curl -sf http://localhost:3000/api/health
```

### 4.3 Pre-Upgrade Checklist

| Check | Command | Required? |
|-------|---------|-----------|
| No active runs | Check dashboard or `SELECT COUNT(*) FROM runs WHERE phase NOT IN ('completed','cancelled')` against `conductor.db` | Recommended |
| Database backup | `cp conductor.db conductor.db.bak-$(date +%Y%m%d)` | Required |
| Disk space | `df -h .` | > 2x database size |
| Current version | `node -e "console.log(require('./packages/web/package.json').version)"` | Informational |

---

## 5. Rollback Procedure

### 5.1 When Rollback Is Needed

- Migration failed mid-execution (application exited with error)
- New version has critical bugs discovered post-upgrade
- Data corruption detected after upgrade

### 5.2 Rollback Steps

```bash
# 1. Stop services (Ctrl-C on pnpm dev:web and pnpm dev:worker)

# 2. Restore database from pre-upgrade backup (no restore.sh script — manual)
cp conductor.db.bak-<pre-upgrade-timestamp> conductor.db

# 3. Deploy previous version
git checkout v0.1.0
pnpm install && pnpm build

# 4. Start services
pnpm dev:web &
pnpm dev:worker &

# 5. Verify
curl -sf http://localhost:3000/api/health
```

### 5.3 Rollback Limitations

| Scenario | Can Rollback? | Notes |
|----------|---------------|-------|
| Migration not yet run | Yes | Just deploy old version |
| Migration ran, no data changes | Yes | Restore backup + old version |
| Migration ran, data transformed | Yes, with data loss | Backup restore loses post-upgrade data |
| Migration ran, new data created | Partial | New records lost on restore |

**Key principle:** Forward-only migrations + backup discipline. Always backup before upgrading.

---

## 6. API Versioning Strategy

### 6.1 Current State (v0.1)

No API versioning. All routes are unversioned:
- `GET /api/projects`
- `GET /api/runs`
- `POST /api/webhooks/github`

### 6.2 Versioning Plan (When Needed)

When a breaking API change is required:

| Strategy | Approach |
|----------|----------|
| **URL prefix** | `/api/v2/projects` alongside `/api/v1/projects` |
| **Deprecation header** | `Deprecation: true` + `Sunset: <date>` on old endpoints |
| **Compatibility window** | Old version supported for 2 minor releases |

### 6.3 Deprecation Policy

1. **Announce** deprecation in release notes and `Deprecation` response header
2. **Support** deprecated endpoint for at least 2 minor versions (e.g., deprecated in v0.2, removed in v0.4)
3. **Log** usage of deprecated endpoints at `warn` level
4. **Remove** only in a minor version bump with changelog entry

---

## 7. Configuration Migration

### 7.1 Environment Variable Changes

When environment variable names change between versions:

1. **Support both names** for one minor version (old name logs deprecation warning)
2. **Document** the change in `CHANGELOG.md` and `.env.example`
3. **Remove** old name support in the following minor version

```typescript
// Example: CONDUCTOR_LOG_LEVEL → LOG_LEVEL
const logLevel = process.env.LOG_LEVEL
  ?? process.env.CONDUCTOR_LOG_LEVEL  // deprecated
  ?? 'info';
if (process.env.CONDUCTOR_LOG_LEVEL) {
  logger.warn('CONDUCTOR_LOG_LEVEL is deprecated, use LOG_LEVEL');
}
```

### 7.2 Config File Format Changes

Currently no config file (all env vars). If a config file is introduced:

- Use JSON Schema for validation
- Include `version` field in config file
- Provide `conductor config migrate` CLI command for format conversion

---

## 8. Data Compatibility Guarantees

### 8.1 Between Patch Versions (v0.1.x → v0.1.y)

| Guarantee | Status |
|-----------|--------|
| Database schema unchanged | Yes |
| API response shapes unchanged | Yes |
| Event payload shapes unchanged | Yes |
| Config format unchanged | Yes |

### 8.2 Between Minor Versions (v0.x → v0.y)

| Guarantee | Status |
|-----------|--------|
| Database automatically migrated | Yes (forward-only) |
| API response shapes may change | Deprecated endpoints supported for 2 versions |
| Event payloads may gain fields | Existing fields not removed without deprecation |
| Config format may change | Old names supported for 1 version |

---

## 9. Cross-References

| Topic | Document |
|-------|----------|
| Database schema and migration details | `docs/DATA_MODEL_AUTHORITY.md` |
| Backup and restore procedures | `docs/DEPLOYMENT.md` § 5 |
| API endpoint specifications | `docs/API_CONTRACTS.md` |
| Event payload formats | `docs/EVENT_MODEL.md` |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-21
**Reviewer:** Codex (read-only sandbox)
**Findings:** 4 total — 2 BLOCKING, 1 HIGH, 1 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §4, §5 | `./scripts/backup.sh` and `./scripts/restore.sh` don't exist in the repo | Replaced with manual `cp` commands and noted no backup scripts exist |
| 2 | BLOCKING | §4.1, §4.2, §4.3 | Docker Compose services `conductor` and `worker` not defined — only `redis` is in `docker-compose.yml` | Rewrote upgrade/rollback procedures using `pnpm dev:web` / `pnpm dev:worker` |
| 3 | HIGH | §3.1 | "Schema higher than expected logs warning and proceeds" — no max-version check or warning path in `db/index.ts` | Replaced with accurate description of forward-only migration behavior |
| 4 | MEDIUM | §1.5 | Migration category mapping inaccurate (stream-events is migration 018, not in 011-015) | Fixed category table to match actual migration file contents |
