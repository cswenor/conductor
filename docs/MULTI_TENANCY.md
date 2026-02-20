# Multi-Tenancy Model

> **Status:** Normative. This defines the tenancy model, data isolation boundaries, cross-project visibility rules, resource isolation strategy, and future multi-tenant migration path for Conductor.

## 1. Tenancy Model (v0.1)

Conductor v0.1 is **single-tenant, multi-project**:

- **One operator** (authenticated via GitHub OAuth) owns the Conductor instance
- **Multiple projects** organize work across repos
- **All projects belong to the same operator**
- **No shared access** — the instance owner sees everything; no other users exist

```
Conductor Instance (single-tenant)
└── Operator (authenticated user)
    ├── Project A (e.g., "House of Voi")
    │   ├── Repo: house-of-voi/webapp
    │   ├── Repo: house-of-voi/api
    │   └── Runs, Tasks, Events...
    └── Project B (e.g., "My Palate")
        ├── Repo: my-palate/mp-web-app
        └── Runs, Tasks, Events...
```

### 1.1 Tenant Boundary Definition

| Concept | v0.1 Boundary | Enforcement |
|---------|---------------|-------------|
| **Tenant** | Single user (instance owner) | GitHub OAuth session |
| **Project** | Organizational unit within tenant | `project_id` FK on all data tables |
| **Data partition** | Per-project via foreign keys | SQL WHERE clauses + API authorization |
| **Resource partition** | Per-project port allocation | `UNIQUE(project_id, port) WHERE is_active=1` |
| **Compute partition** | Shared worker pool | No per-project quotas in v0.1 |

---

## 2. Data Isolation

### 2.1 Schema Hierarchy

All data tables enforce project isolation through foreign key relationships:

```
projects (project_id PK, user_id NOT NULL FK → users)
├── repos (repo_id PK, project_id FK)
├── tasks (task_id PK, project_id FK, repo_id FK)
├── runs (run_id PK, project_id FK, repo_id FK, task_id FK)
│   ├── events (event_id PK, run_id FK)
│   ├── agent_invocations (invocation_id PK, run_id FK)
│   ├── artifacts (artifact_id PK, run_id FK)
│   ├── github_writes (write_id PK, run_id FK)
│   └── worktrees (worktree_id PK, run_id FK, project_id FK)
├── port_leases (port_lease_id PK, project_id FK)
└── policies (policy_id PK, project_id FK)
```

### 2.2 Isolation Invariants

| Invariant | Enforcement | Location |
|-----------|-------------|----------|
| Every project has an owner | `projects.user_id NOT NULL` | Migration 010 |
| One project per GitHub installation | `UNIQUE(github_installation_id)` | Migration 010 |
| All queries filter by project or user | `WHERE project_id = ?` or `JOIN projects ... WHERE user_id = ?` | All data access functions |
| No cross-project joins without filter | Code review policy | All query functions |
| Cascade deletion on user removal | `ON DELETE CASCADE` from users → projects | Migration 010 |

### 2.3 Authorization Model

Every API request passes through two gates:

1. **Authentication:** `withAuth` middleware validates session cookie, attaches `AuthUser` to request
2. **Authorization:** `canAccessProject(user, project)` checks `project.userId === user.userId`

```typescript
// packages/shared/src/auth/policy.ts
export function canAccessProject(user: AuthUser, project: Project): boolean {
  // v0.1: Owner-only access
  return project.userId === user.userId;
  // v0.3+: Extend to check project_members table
}
```

This function is called on **every** project-scoped API route before data access.

---

## 3. Cross-Project Visibility

### 3.1 Query Patterns

| Query Scope | Behavior | Example |
|-------------|----------|---------|
| List projects | Returns only projects where `user_id = session.userId` | `GET /api/projects` |
| List runs | Filtered by `project_id` parameter OR `user_id` via join | `GET /api/projects/:id/runs` |
| List tasks | Always requires `project_id` parameter | `listTasks(db, projectId)` |
| Analytics | All queries join through projects and filter by `project_id` | Dashboard aggregations |
| Events | Scoped by `run_id` which inherits `project_id` | `GET /api/runs/:id/events` |

### 3.2 Cross-Project Aggregation

In v0.1, since all projects belong to the same operator, cross-project aggregation is permitted for:

- **Dashboard totals** (total runs across all projects)
- **Resource usage** (total active worktrees, port consumption)

These aggregations still filter by `user_id` to ensure future multi-user safety.

---

## 4. Resource Isolation

### 4.1 Filesystem Isolation

| Resource | Isolation Strategy | Path Pattern |
|----------|-------------------|--------------|
| Repo clones | Per-project directory | `${CONDUCTOR_DATA_DIR}/repos/${projectId}/${repoId}` |
| Worktrees | Per-run directory | `${CONDUCTOR_DATA_DIR}/worktrees/${runId}` |
| Port leases | Per-project unique constraint | `UNIQUE(project_id, port) WHERE is_active=1` |

### 4.2 Compute Isolation (v0.1: Shared)

| Resource | Isolation | Limit |
|----------|-----------|-------|
| Worker processes | Shared across all projects | Global `WORKER_CONCURRENCY` (default: 1) |
| BullMQ queues | Shared (single queue per job type) | No per-project quota |
| AI token budget | No per-project limit | Global provider rate limits only |
| GitHub API rate limit | Per-installation (one installation per project) | GitHub's 5,000/hour limit |

**v0.1 implication:** A runaway project can starve others of worker capacity. Acceptable for single-operator use. See § 6 for multi-tenant mitigation.

### 4.3 Concurrency Safety

| Mechanism | What It Protects | Implementation |
|-----------|-----------------|----------------|
| File-based locks | Clone and worktree creation | `acquireFileLock('clone-' + repoId)` |
| Database unique constraints | Port allocation, active worktrees | `UNIQUE INDEX` with `WHERE` clauses |
| BullMQ job deduplication | Duplicate webhook processing | `jobId` based on delivery ID |

---

## 5. Shared vs Isolated Resources

| Resource | Shared | Per-Project | Per-Run |
|----------|--------|-------------|---------|
| Database (SQLite) | Yes | — | — |
| Redis | Yes | — | — |
| Worker pool | Yes | — | — |
| BullMQ queues | Yes | — | — |
| GitHub installation token | — | Yes | — |
| Repo clone (filesystem) | — | Yes | — |
| Worktree (filesystem) | — | — | Yes |
| Port lease | — | Yes (unique) | — |
| Event history | — | Yes (via FK) | Yes (via FK) |
| Policies | — | Yes | — |

---

## 6. Multi-Tenant Migration Path (v0.3)

### 6.1 Changes Required

| Component | v0.1 (Current) | v0.3 (Multi-Tenant) | Migration Impact |
|-----------|----------------|---------------------|------------------|
| Auth | Single user, session-based | Multiple users, GitHub OAuth | Add `project_members` table |
| Authorization | `userId === project.userId` | Role-based (owner/admin/member/viewer) | Extend `canAccessProject()` |
| Queries | Filter by `userId` | Filter by membership lookup | Add `project_members` join |
| Worker pool | Shared, unmetered | Per-project fair scheduling | Add priority queues |
| AI budget | Unlimited | Per-project token limits | Add quota tracking table |
| Billing | None | Usage attribution | Add metering events |

### 6.2 Database Changes for v0.3

```sql
-- New table: project membership
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  PRIMARY KEY (project_id, user_id)
);

-- New table: per-project resource quotas
CREATE TABLE project_quotas (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  max_concurrent_runs INTEGER NOT NULL DEFAULT 5,
  max_ai_tokens_per_day INTEGER NOT NULL DEFAULT 1000000,
  max_worktrees INTEGER NOT NULL DEFAULT 10
);
```

### 6.3 Authorization Extension

```typescript
// v0.3 canAccessProject extension
export function canAccessProject(user: AuthUser, project: Project): boolean {
  // Check direct ownership
  if (project.userId === user.userId) return true;
  // Check membership
  const membership = db.prepare(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND accepted_at IS NOT NULL'
  ).get(project.projectId, user.userId);
  return membership !== undefined;
}
```

---

## 7. Reconciliation Notes

### 7.1 PROJECTS.md States "Multi-Tenant by Design"

This is accurate — the database schema enforces project isolation from day one. However, v0.1 is single-operator (one user owns all projects). The "multi-tenant by design" refers to the data model, not the access control model. This document clarifies the distinction.

### 7.2 MVP_SCOPE.md States "Project Ownership Enforced"

Correct. Migration 010 enforces `projects.user_id NOT NULL` and `canAccessProject()` gates every API call. Cross-project data leakage is not possible through the API layer.

---

## 8. Cross-References

| Topic | Document |
|-------|----------|
| Authentication and session management | `docs/AUTH.md` |
| API authorization per endpoint | `docs/API_CONTRACTS.md` |
| Database schema and migrations | `docs/DATA_MODEL_AUTHORITY.md` |
| Resource quotas and rate limiting | `docs/RATE_LIMITING.md` |
| Project hierarchy | `docs/PROJECTS.md` |
