# API Contracts

> **Status:** Normative. This is the canonical reference for all Conductor HTTP endpoints, WebSocket/SSE streams, webhook receivers, and internal communication protocols. Implementations MUST conform to these schemas.

## 1. Conventions

### 1.1 Base URL

All Control Plane API endpoints are served under `/api/`. Self-hosted instances use `BASE_URL` from environment (see AUTH.md § 10).

### 1.2 Authentication

Unless marked "None", all endpoints require one of:
- **Session cookie:** `conductor_session` (set by GitHub OAuth flow)
- **API key:** `Authorization: Bearer ck_...` header

See AUTH.md § 1–3 for full auth flow details.

### 1.3 Standard Error Format

All error responses use a consistent envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": {}
  }
}
```

| HTTP Status | When Used |
| --- | --- |
| 400 | Malformed request body, missing required fields |
| 401 | No session cookie or API key, expired session |
| 403 | Valid auth but insufficient permissions for this project/run |
| 404 | Resource not found (run, project, repo) |
| 409 | Conflict (invalid phase transition, duplicate resource) |
| 422 | Valid JSON but business rule violation (WIP limit, max retries) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

**Error codes** are SCREAMING_SNAKE_CASE strings. Common codes:

| Code | Status | Meaning |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing or invalid auth |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `INVALID_TRANSITION` | 409 | Phase transition not allowed from current state |
| `RUN_BLOCKED` | 409 | Run is in `failed` state, requires operator decision |
| `RUN_PAUSED` | 409 | Run is paused, must resume before state changes |
| `WIP_LIMIT_EXCEEDED` | 422 | Too many active runs for this project |
| `MAX_RETRIES_EXCEEDED` | 422 | Retry budget exhausted (see RUN_STATE_MACHINE.md § 5.4) |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### 1.4 Pagination

List endpoints use **cursor-based pagination** for forward iteration and **offset-based pagination** for random access:

```
GET /api/runs?limit=20&offset=0
GET /api/runs?limit=20&cursor=eyJpZCI6MTIzfQ
```

Response:

```json
{
  "items": [...],
  "total": 150,
  "next_cursor": "eyJpZCI6MTQzfQ"
}
```

| Parameter | Type | Default | Max |
| --- | --- | --- | --- |
| `limit` | integer | 20 | 100 |
| `offset` | integer | 0 | — |
| `cursor` | string (opaque) | — | — |

When `cursor` is present, `offset` is ignored. Cursors are opaque base64-encoded JSON; clients must not parse them.

### 1.5 Rate Limiting

Default: 100 requests/minute per session. Headers on every response:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1708444800
```

On 429, body includes `retry_after` in seconds:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "details": { "retry_after": 12 }
  }
}
```

### 1.6 Idempotency

Mutation endpoints (POST, PUT, DELETE) accept an optional `Idempotency-Key` header:

```
Idempotency-Key: ik_a1b2c3d4e5f6
```

- Keys are scoped to the authenticated user
- Replayed requests return the original response (200, not 201)
- Keys expire after 24 hours
- GET requests do not require idempotency keys

See also: IDEMPOTENCY.md for the full idempotency protocol.

---

## 2. Runs API

### 2.1 List Runs

```
GET /api/runs
```

**Query Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string (UUID) | No | Filter by project |
| `phase` | RunPhase | No | Filter by single phase |
| `phases` | RunPhase[] (comma-separated) | No | Filter by multiple phases |
| `excludePaused` | boolean | No | Exclude paused runs |
| `includePaused` | boolean | No | Include paused runs (default: true) |
| `completedAfter` | ISO 8601 | No | Only completed runs after this date |
| `result` | string | No | Filter by result (success/failure) |
| `hasPrUrl` | boolean | No | Filter by PR presence |
| `sortBy` | string | No | Sort field (default: `created_at`) |
| `sortDir` | `asc` \| `desc` | No | Sort direction (default: `desc`) |
| `countOnly` | boolean | No | Return only total count |
| `limit` | integer | No | Page size (default: 20, max: 100) |
| `offset` | integer | No | Page offset |

**Response (200):**

```json
{
  "runs": [
    {
      "id": "run_abc123",
      "project_id": "proj_xyz",
      "phase": "executing",
      "step": "implementer_apply_changes",
      "paused_at": null,
      "title": "Add user authentication",
      "work_item": {
        "id": "wi_123",
        "type": "feature",
        "github_issue_number": 42,
        "github_issue_url": "https://github.com/org/repo/issues/42"
      },
      "pr_url": "https://github.com/org/repo/pull/43",
      "pr_number": 43,
      "branch": "feature/add-auth",
      "created_at": "2026-02-20T10:00:00Z",
      "updated_at": "2026-02-20T12:30:00Z",
      "check_fix_attempts": 1,
      "review_rounds": 0,
      "failed_retries": 0
    }
  ],
  "total": 47
}
```

### 2.2 Get Run

```
GET /api/runs/:id
```

**Response (200):** Same shape as list item, plus expanded fields:

```json
{
  "id": "run_abc123",
  "project_id": "proj_xyz",
  "phase": "executing",
  "step": "implementer_apply_changes",
  "paused_at": null,
  "title": "Add user authentication",
  "work_item": {
    "id": "wi_123",
    "type": "feature",
    "github_issue_number": 42,
    "github_issue_url": "https://github.com/org/repo/issues/42",
    "title": "Add user authentication",
    "body": "...",
    "labels": ["feature", "area:backend"]
  },
  "pr_url": "https://github.com/org/repo/pull/43",
  "pr_number": 43,
  "branch": "feature/add-auth",
  "worktree_path": "/tmp/conductor/worktrees/run_abc123",
  "artifacts": [
    {
      "id": "art_001",
      "type": "PLAN",
      "version": 2,
      "created_at": "2026-02-20T10:05:00Z"
    }
  ],
  "recent_events": [
    {
      "event_id": "evt_xyz",
      "type": "phase.transitioned",
      "sequence": 5,
      "payload": { "from": "checking", "to": "executing", "trigger": "gate_result" },
      "created_at": "2026-02-20T12:30:00Z"
    }
  ],
  "check_fix_attempts": 1,
  "review_rounds": 0,
  "failed_retries": 0,
  "created_at": "2026-02-20T10:00:00Z",
  "updated_at": "2026-02-20T12:30:00Z"
}
```

### 2.3 Create Run

```
POST /api/projects/:projectId/runs
```

**Request Body:**

```json
{
  "taskId": "wi_123",
  "repoId": "repo_456",
  "github": {
    "nodeId": "I_kwDOBx...",
    "issueNumber": 42,
    "type": "issue",
    "title": "Add user authentication",
    "body": "## Problem\n...",
    "state": "open",
    "labelsJson": "[\"feature\", \"area:backend\"]"
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `taskId` | string | No | Existing work item ID (omit to create from GitHub data) |
| `repoId` | string | Yes | Repository to run against |
| `github.nodeId` | string | Yes | GitHub GraphQL node ID |
| `github.issueNumber` | integer | Yes | GitHub issue number |
| `github.type` | `issue` \| `pull_request` | Yes | Source type |
| `github.title` | string | Yes | Issue/PR title |
| `github.body` | string | No | Issue/PR body (markdown) |
| `github.state` | string | Yes | GitHub state (`open`, `closed`) |
| `github.labelsJson` | string | No | JSON-encoded label array |

**Response (201):**

```json
{
  "id": "run_abc123",
  "project_id": "proj_xyz",
  "phase": "pending",
  "step": "setup_worktree",
  "created_at": "2026-02-20T10:00:00Z"
}
```

**Errors:**
- 409 `WIP_LIMIT_EXCEEDED` — Too many active runs
- 404 `NOT_FOUND` — Project or repo not found

### 2.4 Run Actions

```
POST /api/runs/:id/actions
```

**Request Body:**

```json
{
  "action": "approve_plan",
  "comment": "Looks good, proceed with implementation",
  "justification": "Optional justification for auditable actions"
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | ActionType | Yes | See action table below |
| `comment` | string | No | Operator feedback (required for `revise_plan`) |
| `justification` | string | No | Required for `grant_policy_exception` |
| `scope` | string | No | Scope for policy exceptions |

**Action Types and Preconditions:**

| Action | Valid From Phase | Transition | Step-Up Auth Required |
| --- | --- | --- | --- |
| `approve_plan` | `awaiting_plan_approval` | → `executing` | Yes (if session > 4h) |
| `revise_plan` | `awaiting_plan_approval` | → `planning` | No |
| `reject_run` | `awaiting_plan_approval` | → `cancelled` | No |
| `retry` | `failed` | → `planning` or `executing` | No |
| `pause` | Any active phase | Sets `paused_at` | No |
| `resume` | Any paused phase | Clears `paused_at` | No |
| `grant_policy_exception` | `failed` (policy block) | → previous phase | Yes (always) |
| `deny_policy_exception` | `failed` (policy block) | → `cancelled` | No |
| `cancel` | Any non-terminal | → `cancelled` | No |

**Response (200):**

```json
{
  "success": true,
  "outcome": "Plan approved, implementation starting",
  "run": {
    "id": "run_abc123",
    "phase": "executing",
    "step": "implementer_apply_changes"
  }
}
```

**Errors:**
- 409 `INVALID_TRANSITION` — Action not valid from current phase
- 409 `RUN_PAUSED` — Must resume before taking action
- 401 `STEP_UP_REQUIRED` — Re-authentication needed (see AUTH.md § 4)
- 422 `MAX_RETRIES_EXCEEDED` — Cannot retry (budget exhausted)

### 2.5 Update Run Workflow

```
PUT /api/runs/:id/workflow
```

**Request Body:**

```json
{
  "phase": "executing",
  "step": "implementer_apply_changes",
  "trigger": "operator_action",
  "reason": "Plan approved by operator"
}
```

> **Note:** This is the internal workflow mutation endpoint used by the orchestrator. Operators should use `POST /api/runs/:id/actions` (§ 2.4) instead. Direct workflow updates require system-level authorization.

### 2.6 Get Run Workflow (Read)

```
GET /api/runs/:id/workflow
```

> **Implementation status:** Not yet implemented in code. Workflow state is currently returned as part of `GET /api/runs/:id`. This endpoint is planned for dedicated workflow inspection.

**Response (200):**

```json
{
  "run_id": "run_abc123",
  "phase": "executing",
  "step": "implementer_apply_changes",
  "paused_at": null,
  "counters": {
    "check_fix_attempts": 1,
    "review_rounds": 0,
    "failed_retries": 0
  },
  "phases": [
    {
      "phase": "pending",
      "phase_name": "Setup",
      "entered_at": "2026-02-20T10:00:00Z",
      "exited_at": "2026-02-20T10:01:00Z",
      "duration_ms": 60000
    },
    {
      "phase": "planning",
      "phase_name": "Planning",
      "entered_at": "2026-02-20T10:01:00Z",
      "exited_at": "2026-02-20T10:15:00Z",
      "duration_ms": 840000
    }
  ],
  "events": [
    {
      "event_id": "evt_001",
      "type": "phase.transitioned",
      "sequence": 1,
      "payload": { "from": "pending", "to": "planning", "trigger": "agent_output" },
      "created_at": "2026-02-20T10:01:00Z"
    }
  ]
}
```

### 2.6 Get Agent Message

```
GET /api/runs/:id/messages/:invocationId
```

**Response (200):**

```json
{
  "invocation_id": "inv_abc",
  "agent_type": "planner",
  "run_id": "run_abc123",
  "input": { "work_item": {}, "context": {} },
  "output": { "summary": "...", "artifacts": [] },
  "status": "completed",
  "started_at": "2026-02-20T10:01:00Z",
  "completed_at": "2026-02-20T10:14:00Z",
  "tokens_used": 45000
}
```

---

## 3. Projects API

### 3.1 List Projects

```
GET /api/projects
```

**Response (200):**

```json
{
  "projects": [
    {
      "id": "proj_xyz",
      "name": "My Application",
      "github_installation_id": "inst_123",
      "github_org_name": "my-org",
      "default_base_branch": "main",
      "port_range_start": 3100,
      "port_range_end": 3199,
      "settings": {
        "max_check_attempts": 3,
        "max_review_rounds": 5,
        "max_failed_retries": 3,
        "autonomy_level": 2,
        "stale_thresholds": {}
      },
      "created_at": "2026-01-15T09:00:00Z",
      "updated_at": "2026-02-20T08:00:00Z"
    }
  ]
}
```

### 3.2 Create Project

```
POST /api/projects
```

**Request Body:**

```json
{
  "name": "My Application",
  "githubInstallationId": "inst_123",
  "githubOrgId": "12345",
  "githubOrgNodeId": "O_kgDOBx...",
  "githubOrgName": "my-org",
  "githubProjectsV2Id": "PVT_kwDOBx...",
  "defaultBaseBranch": "main",
  "portRangeStart": 3100,
  "portRangeEnd": 3199
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Project display name |
| `githubInstallationId` | string | Yes | GitHub App installation ID |
| `githubOrgId` | string | Yes | GitHub org numeric ID |
| `githubOrgNodeId` | string | Yes | GitHub org GraphQL node ID |
| `githubOrgName` | string | Yes | GitHub org login name |
| `githubProjectsV2Id` | string | No | GitHub Projects v2 ID for mirroring |
| `defaultBaseBranch` | string | No | Default: `main` |
| `portRangeStart` | integer | No | Port range for worktree isolation |
| `portRangeEnd` | integer | No | Port range end |

**Response (201):** Full project object.

### 3.3 Get Project

```
GET /api/projects/:id
```

**Response (200):** Full project object (same as list item).

### 3.4 Update Project

```
PATCH /api/projects/:id
```

**Request Body:** Partial project fields (same schema as create, all optional).

**Response (200):** Updated project object.

### 3.5 Delete Project

```
DELETE /api/projects/:id
```

**Response (200):**

```json
{ "success": true }
```

**Errors:**
- 409 — Project has active runs (must cancel/complete all first)

---

## 4. Repositories API

### 4.1 List Project Repos

```
GET /api/projects/:projectId/repos
```

**Response (200):**

```json
{
  "repos": [
    {
      "id": "repo_456",
      "project_id": "proj_xyz",
      "github_repo_node_id": "R_kgDOBx...",
      "github_repo_name": "my-app",
      "owner": "my-org",
      "default_branch": "main",
      "created_at": "2026-01-15T09:05:00Z"
    }
  ]
}
```

### 4.2 Add Repo to Project

```
POST /api/projects/:projectId/repos
```

**Request Body:**

```json
{
  "repoId": "repo_456",
  "githubRepoNodeId": "R_kgDOBx...",
  "githubRepoName": "my-app",
  "owner": "my-org",
  "branch": "main"
}
```

**Response (201):** Full repo object.

### 4.3 List Available Repos

```
GET /api/projects/:projectId/repos/available?installationId=inst_123
```

Returns repos from the GitHub installation that aren't yet added to the project.

**Response (200):**

```json
{
  "repos": [
    {
      "github_repo_node_id": "R_kgDOBx...",
      "name": "other-app",
      "owner": "my-org",
      "default_branch": "main",
      "private": true,
      "already_added": false
    }
  ]
}
```

### 4.4 Get/Update/Delete Repo

```
GET    /api/projects/:projectId/repos/:repoId
PATCH  /api/projects/:projectId/repos/:repoId
DELETE /api/projects/:projectId/repos/:repoId
```

**GET Response (200):** Full repo object (same as list item).

**PATCH Request Body:** Partial repo fields (e.g., `{ "default_branch": "develop" }`).

**PATCH Response (200):** Updated repo object.

**DELETE Response (200):** `{ "success": true }`

**DELETE Errors:**
- 409 — Repo has active runs (must cancel/complete first)

### 4.5 Detect Build Profile

```
POST /api/projects/:projectId/repos/detect-profile
```

**Request Body:**

```json
{
  "owner": "my-org",
  "repo": "my-app"
}
```

Auto-detects the repo's build system, test runner, and language.

**Response (200):**

```json
{
  "profile": {
    "language": "typescript",
    "framework": "next",
    "package_manager": "pnpm",
    "test_runner": "vitest",
    "build_command": "pnpm build",
    "test_command": "pnpm test",
    "lint_command": "pnpm lint"
  },
  "confidence": 0.92
}
```

---

## 5. Events API

### 5.1 SSE Event Stream

```
GET /api/events/stream
```

**Auth:** Session cookie required (not API key — SSE requires cookie for browser EventSource).

**Headers:**
- `Last-Event-ID`: Resume from this event ID (replay missed events from `stream_events` table)

**Response:** Server-Sent Events stream.

```
id: evt_001
event: run.phase_changed
data: {"kind":"run.phase_changed","runId":"run_abc123","projectId":"proj_xyz","phase":"executing","previousPhase":"checking","timestamp":"2026-02-20T12:30:00Z"}

id: evt_002
event: gate.evaluated
data: {"kind":"gate.evaluated","gateId":"gate_tests","status":"passed","runId":"run_abc123","projectId":"proj_xyz","timestamp":"2026-02-20T12:29:55Z"}

: heartbeat
```

**Event Types (StreamEventV2 union):**

| Event Kind | Payload Fields | When Emitted |
| --- | --- | --- |
| `run.phase_changed` | `runId`, `projectId`, `phase`, `previousPhase`, `trigger`, `timestamp` | Phase transition (T1-T18) |
| `run.updated` | `runId`, `projectId`, `timestamp` | Any run metadata change |
| `gate.evaluated` | `gateId`, `status` (`pending`/`passed`/`failed`), `runId`, `projectId` | Automated check result |
| `operator.action` | `action`, `operator`, `runId`, `projectId` | Operator decision |
| `agent.invocation` | `agent`, `runId`, `operation`, `projectId` | Agent started work |
| `project.updated` | `projectId` | Project settings changed |
| `refresh_required` | `reason` | Client should full-refresh |

**Connection lifecycle:**
1. Client opens SSE connection with session cookie
2. Server subscribes to Redis channels for user's project IDs
3. Events fan out from shared per-process Redis subscriber
4. Heartbeat every 30 seconds (`: heartbeat\n\n`)
5. On disconnect, client reconnects with `Last-Event-ID`

**TanStack Query cache invalidation:**

| Event Kind | Query Keys to Invalidate |
| --- | --- |
| `run.phase_changed` | `['runs']`, `['runs', runId]`, `['runs', runId, 'workflow']` |
| `run.updated` | `['runs', runId]` |
| `gate.evaluated` | `['runs', runId, 'workflow']` |
| `operator.action` | `['runs', runId]`, `['approvals', 'count']` |
| `project.updated` | `['projects']`, `['projects', projectId]` |
| `refresh_required` | All queries |

### 5.2 Recent Events

```
GET /api/events/recent
```

**Query Parameters:**

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `projectId` | string | — | Filter by project (required) |
| `limit` | integer | 50 | Max events (max: 200) |
| `since` | ISO 8601 | — | Events after this timestamp |

**Response (200):**

```json
{
  "events": [
    {
      "event_id": "evt_001",
      "kind": "run.phase_changed",
      "run_id": "run_abc123",
      "project_id": "proj_xyz",
      "payload": { "phase": "executing", "previousPhase": "checking" },
      "timestamp": "2026-02-20T12:30:00Z"
    }
  ]
}
```

---

## 6. Authentication API

### 6.1 Get Session

```
GET /api/auth/session
```

**Auth:** Session cookie (optional — returns null user if no session).

**Response (200):**

```json
{
  "user": {
    "id": "user_abc",
    "githubId": "12345",
    "githubLogin": "octocat",
    "githubName": "The Octocat",
    "githubAvatarUrl": "https://avatars.githubusercontent.com/u/12345"
  }
}
```

Or when not authenticated:

```json
{
  "user": null
}
```

### 6.2 Initiate GitHub OAuth

```
GET /api/auth/github
```

**Auth:** None.

Redirects to GitHub OAuth authorization page with CSRF-safe `state` token. See AUTH.md § 1 for full OAuth flow.

### 6.3 GitHub OAuth Callback

```
GET /api/auth/github/callback?code=...&state=...
```

**Auth:** None (callback from GitHub).

On success: Sets `conductor_session` cookie, redirects to `/`.
On failure: Redirects to `/login?error=...`.

### 6.4 Logout

```
DELETE /api/auth/session
```

**Response (200):**

```json
{ "success": true }
```

Clears session cookie and invalidates server-side session.

### 6.5 GitHub App Installation

```
GET /api/github/install
```

Redirects to GitHub App installation flow.

```
GET /api/github/callback?installation_id=...&setup_action=install
```

**Auth:** None (callback from GitHub). Validated via signed `state` parameter.

Handles post-installation callback.

---

## 7. GitHub Integration API

### 7.1 List Installations

```
GET /api/github/installations
```

**Response (200):**

```json
{
  "installations": [
    {
      "id": "inst_123",
      "account": {
        "login": "my-org",
        "type": "Organization",
        "avatar_url": "https://..."
      },
      "repository_count": 15,
      "created_at": "2026-01-10T09:00:00Z"
    }
  ]
}
```

### 7.2 List Installation Repos

```
GET /api/github/installations/:installationId/repos
```

**Response (200):**

```json
{
  "repositories": [
    {
      "id": 123456,
      "node_id": "R_kgDOBx...",
      "name": "my-app",
      "full_name": "my-org/my-app",
      "private": true,
      "default_branch": "main"
    }
  ]
}
```

### 7.3 GitHub Connection Status

```
GET /api/github/status
```

**Auth:** None (public health check).

**Response (200):**

```json
{
  "configured": true,
  "app_id": "123456",
  "org_count": 2
}
```

---

## 8. User API

### 8.1 API Keys

```
GET /api/user/api-keys
```

**Response (200):**

```json
{
  "apiKeys": [
    {
      "id": "key_abc",
      "prefix": "ck_abc1",
      "created_at": "2026-02-01T09:00:00Z",
      "expires_at": "2026-05-01T09:00:00Z",
      "last_used_at": "2026-02-20T08:00:00Z"
    }
  ]
}
```

```
PUT /api/user/api-keys
```

Creates or rotates an API key.

**Response (200):**

```json
{
  "apiKey": "ck_abc123def456ghi789...",
  "expiresAt": "2026-05-20T10:00:00Z"
}
```

> **Important:** The full API key is only returned once. The `GET` endpoint returns only the prefix.

```
DELETE /api/user/api-keys
```

Revokes all API keys for the current user.

**Response (200):** `{ "success": true }`

### 8.2 Approval Count

```
GET /api/approvals/count
```

Returns count of runs awaiting operator action (phases: `awaiting_plan_approval`, `awaiting_review`, `awaiting_merge`).

**Response (200):**

```json
{ "count": 3 }
```

### 8.3 Build Profiles

```
GET /api/profiles
```

**Auth:** None (public reference data).

Returns available CI/build profile templates.

**Response (200):**

```json
{
  "profiles": [
    {
      "id": "next-pnpm",
      "name": "Next.js (pnpm)",
      "language": "typescript",
      "framework": "next",
      "package_manager": "pnpm",
      "build_command": "pnpm build",
      "test_command": "pnpm test"
    }
  ]
}
```

---

## 9. Health API

### 9.1 Basic Health

```
GET /api/health
```

**Auth:** None.

**Response (200):**

```json
{
  "status": "ok",
  "timestamp": "2026-02-20T10:00:00Z",
  "version": "0.1.0",
  "environment": "production"
}
```

### 9.2 Redis Health

```
GET /api/health/redis
```

**Auth:** None.

**Response (200):**

```json
{
  "redis": "connected",
  "latency_ms": 2
}
```

On failure:

```json
{
  "redis": "error",
  "latency_ms": null,
  "error": "Connection refused"
}
```

---

## 10. Webhooks

### 10.1 GitHub Webhook Receiver

```
POST /api/webhooks/github
```

**Auth:** HMAC-SHA256 signature verification via `X-Hub-Signature-256` header.

**Headers:**

| Header | Description |
| --- | --- |
| `X-GitHub-Delivery` | Unique delivery UUID |
| `X-GitHub-Event` | Event type (e.g., `pull_request`, `issues`) |
| `X-Hub-Signature-256` | `sha256=<hmac>` of request body |

**Processing:** Webhooks are enqueued to the `webhooks` BullMQ queue for async processing. The endpoint returns 200 immediately after validation and enqueue.

**Response (200):**

```json
{ "received": true }
```

**Response (401):** Invalid signature.

**Supported Events:**

| Event | Actions Handled | Effect |
| --- | --- | --- |
| `issues` | `opened`, `edited`, `labeled`, `closed` | Work item sync |
| `issue_comment` | `created` | Feedback capture |
| `pull_request` | `opened`, `closed`, `merged`, `review_requested` | PR lifecycle |
| `pull_request_review` | `submitted` | Review gate evaluation |
| `push` | — | Branch update detection |
| `check_suite` | `completed` | CI result capture |
| `check_run` | `completed` | Individual check result |
| `installation` | `created`, `deleted` | App lifecycle |
| `installation_repositories` | `added`, `removed` | Repo access changes |

**Idempotency:** Webhook delivery IDs (`X-GitHub-Delivery`) are stored. Duplicate deliveries are acknowledged (200) but not re-processed.

### 10.2 Webhook Health

```
GET /api/webhooks/github
```

**Auth:** None.

**Response (200):**

```json
{
  "status": "ok",
  "supported_events": ["issues", "issue_comment", "pull_request", "pull_request_review", "push", "check_suite", "check_run", "installation", "installation_repositories"]
}
```

---

## 11. Internal Communication Protocols

### 11.1 Job Queue (BullMQ over Redis)

All internal async communication uses BullMQ queues with HMAC-SHA256 signed job envelopes (see AUTH.md § 8).

**Queues:**

| Queue Name | Producer | Consumer | Purpose |
| --- | --- | --- | --- |
| `webhooks` | API webhook handler | Worker | Async GitHub event processing |
| `runs` | API (create/action) | Worker/Orchestrator | Run lifecycle commands |
| `agents` | Orchestrator | Worker | AI agent invocations |
| `cleanup` | Worker | Worker | Resource cleanup (worktrees, ports, branches) |

**Job Envelope:**

```json
{
  "job_id": "job_abc123",
  "queue": "runs",
  "payload": {
    "run_id": "run_abc123",
    "action": "start"
  },
  "signature": "sha256:...",
  "created_at": "2026-02-20T10:00:00Z",
  "correlation_id": "corr_xyz"
}
```

### 11.2 Worker Task Protocol

#### Task Request (Orchestrator → Worker)

```json
{
  "task_id": "task_abc123",
  "run_id": "run_abc123",
  "correlation_id": "corr_xyz",
  "operation": "implementation.execute",
  "input": {
    "work_item": {
      "id": "wi_123",
      "title": "Add user authentication",
      "type": "feature",
      "acceptance_criteria": ["OAuth login works", "Session persists"]
    },
    "artifacts": [
      { "type": "PLAN", "content": "..." }
    ],
    "context": {
      "area": "backend",
      "approach_suggestion": "Use Passport.js",
      "history_insights": {}
    }
  },
  "constraints": {
    "timeout_ms": 1800000,
    "token_budget": 100000,
    "sandbox_mode": "workspace-write",
    "autonomy_level": 2
  }
}
```

**Operation Types:**

| Operation | Worker Type | Phase |
| --- | --- | --- |
| `planning.create_plan` | AI (planner) | `planning` |
| `planning.review_plan` | AI (reviewer) | `planning` |
| `implementation.execute` | AI (implementer) | `executing` |
| `testing.run_tests` | Script | `checking` |
| `testing.lint` | Script | `checking` |
| `testing.security_scan` | Script | `checking` |
| `review.code_review` | AI (reviewer) | `awaiting_review` |

#### Task Result (Worker → Orchestrator)

```json
{
  "task_id": "task_abc123",
  "state": "completed",
  "output": {
    "summary": "Implementation complete. 5 files changed.",
    "details": "Added OAuth routes, session middleware, and login page.",
    "files_changed": ["src/auth.ts", "src/middleware.ts", "src/pages/login.tsx"]
  },
  "artifacts": [
    {
      "type": "CODE",
      "path": "src/auth.ts",
      "hash": "sha256:abc123..."
    },
    {
      "type": "TEST_REPORT",
      "path": ".conductor/reports/test-run-001.json",
      "hash": "sha256:def456..."
    }
  ],
  "metrics": {
    "duration_ms": 120000,
    "tokens_used": 45000
  }
}
```

**Task States:**

| State | Meaning |
| --- | --- |
| `completed` | Task finished successfully |
| `failed` | Task failed with error |
| `input-required` | Agent needs human input (questions) |

#### Worker Registration

```json
{
  "worker_id": "script-eslint-1",
  "worker_type": "script",
  "display_name": "ESLint Checker",
  "capabilities": [
    { "operation": "testing.lint", "priority_boost": 0 }
  ],
  "max_parallel": 8
}
```

**Worker Types:** `script` (deterministic), `ai` (LLM-based), `human` (manual review).

#### Heartbeat (every 30 seconds)

```json
{
  "worker_id": "script-eslint-1",
  "status": "active",
  "current_task_count": 2,
  "resource_usage": {
    "cpu_percent": 45.2,
    "memory_mb": 512
  }
}
```

### 11.3 Event Protocol

All state mutations produce events stored in the `events` table and published to Redis per project.

```typescript
interface DecisionEvent {
  event_id: string;           // UUID
  run_id: string;             // UUID
  sequence: number;           // Monotonic per run, gap-free
  type: EventType;            // See below
  class: 'decision' | 'fact'; // Only decisions mutate run state
  payload: {
    from?: RunPhase;          // Previous phase (for transitions)
    to?: RunPhase;            // New phase (for transitions)
    reason?: string;          // Human-readable reason
    trigger: TriggerType;     // See RUN_STATE_MACHINE.md § 5.7
    evidence?: object;        // Supporting data (gate results, error details)
  };
  created_at: string;         // ISO 8601
  processed_at?: string;      // When consumed by orchestrator
  causation_id?: string;      // Event that triggered this event
  correlation_id?: string;    // For retry chains and tracing
}
```

**Event Types:**

| Type | Class | Meaning |
| --- | --- | --- |
| `phase.transitioned` | decision | Run phase changed (T1-T18) |
| `phase.transition_rejected` | fact | Invalid transition attempted |
| `phase.transition_denied` | fact | Unauthorized transition attempted |
| `checkpoint.completed` | decision | Internal step completed |
| `gate.evaluated` | fact | Automated check produced result |
| `artifact.created` | fact | New artifact version created |
| `agent.invoked` | fact | Agent started processing |
| `agent.completed` | fact | Agent finished processing |
| `webhook.received` | fact | GitHub webhook processed |

**Ordering guarantee:** Events for a single run are processed in strict `sequence` order. Out-of-order arrival is handled by buffering until the preceding sequence arrives.

---

## 12. GitHub Write Boundaries

Conductor writes to GitHub through a controlled integration layer. All writes are scoped to the current run.

### 12.1 Allowed Writes

| Target | Rate Limit | Used For |
| --- | --- | --- |
| Issue comments (original issue) | 1/30s per run (burst 3) | Status updates, plan summaries, review results |
| PR comments | 1/30s per run (burst 3) | Code review feedback |
| PR review comments (inline) | 1/30s per run (burst 3) | Line-level review feedback |
| Check runs (Conductor-owned) | No limit | Run status reporting |
| GitHub Project field updates | On phase transition | Phase mirroring (see RUN_STATE_MACHINE.md § 8) |

**Priority bypass:** Error notifications and human-gate questions bypass rate limits.

### 12.2 Blocked Writes

These operations are **never** performed by Conductor:

| Operation | Reason |
| --- | --- |
| Creating/closing issues | Operator-only action |
| Editing/deleting comments | Immutability principle |
| Merging PRs | Human gate (see RUN_STATE_MACHINE.md § 2.1) |
| Modifying repo settings | Out of scope |
| Force-pushing | Destructive action |

---

## 13. Protocol Invariants

These rules are enforced at every layer and must never be violated:

### 13.1 Authority Boundaries

| Actor | May Do | May NOT Do |
| --- | --- | --- |
| **Orchestrator** | Emit `phase.transitioned` events, emit `checkpoint.completed` | — |
| **Webhooks** | Write `fact` events only | Mutate run state |
| **Agents** | Propose, review, report | Mutate run state directly |
| **Operators** | Trigger actions via API | Bypass phase transition rules |
| **GitHub** | Mirror surface only | Act as source of truth |

### 13.2 Immutability Rules

- **Artifacts** are append-only; revisions create new versions with incremented version numbers
- **Events** are never edited or deleted
- **GitHub comments** posted by Conductor are never edited or deleted
- **Audit log entries** are append-only

### 13.3 Ordering Rules

- Run event processing uses `sequence` (not `created_at`)
- Events processed in strict order: `sequence 1, 2, 3...`
- Out-of-order arrival: buffer and wait for prior sequence
- Gap detection: if sequence N+2 arrives without N+1, alert after 60s timeout

---

## 14. Cross-References

| Topic | Document |
| --- | --- |
| Run phase values and transitions | `docs/RUN_STATE_MACHINE.md` |
| Authentication and authorization | `docs/AUTH.md` |
| Database schemas | `docs/DATA_MODEL_AUTHORITY.md` |
| Worker credentials | `docs/WORKER_CREDENTIALS.md` |
| UI integration | `docs/ui/CONTROL_PLANE_UX_V3.md` |
| Idempotency protocol | `docs/IDEMPOTENCY.md` (see issue #170) |
| Rate limiting details | `docs/RATE_LIMITING.md` (see issue #169) |
| Error handling matrix | `docs/ERROR_HANDLING.md` (see issue #162) |

---

## Appendix A: Codex Adversarial Review Resolutions

15 findings from Codex adversarial review comparing this spec against the actual codebase implementation:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | HIGH | Undocumented repo CRUD endpoints (GET/PATCH/DELETE `:repoId`) | Added § 4.4 with all three methods |
| 2 | BLOCKING | `GET /api/runs/:id/workflow` documented but only `PUT` exists in code | Added § 2.5 (PUT) as the real endpoint; noted GET as planned but unimplemented |
| 3 | HIGH | Detect-profile method mismatch (doc: GET, code: POST with body) | Fixed to POST with `{ owner, repo }` body in § 4.5 |
| 4 | HIGH | Runs query parsing drift (code uses `'1'` booleans, default limit 50) | **Implementation gap** — code should be aligned to this spec during implementation. Spec is normative. |
| 5 | HIGH | Run detail response shape mismatch (code returns nested `{ run, task, repo }`) | **Implementation gap** — documented shape is the target. Code should flatten to match spec. |
| 6 | HIGH | Projects/repos schema drift | **Implementation gap** — spec is normative. Request/response DTOs should be generated from these schemas. |
| 7 | HIGH | GitHub/User/Health field mismatches | **Implementation gap** — minor field naming differences. Spec is target. |
| 8 | BLOCKING | Auth model: docs say session + API key, code only validates session | **Implementation gap** — API key auth middleware must be implemented per AUTH.md § 3. Spec is correct. |
| 9 | BLOCKING | Step-up auth not enforced in actions endpoint | **Implementation gap** — step-up checks must be added for `approve_plan` and `grant_policy_exception` per AUTH.md § 4. |
| 10 | MEDIUM | GitHub callback missing `Auth: None` marker | Fixed — added explicit auth note to § 6.5 |
| 11 | HIGH | Error handling inconsistent (500 instead of 400, fake-success on failure) | **Implementation gap** — centralized error mapping needed. Spec defines target behavior. |
| 12 | HIGH | Pagination: code uses offset-only, not cursor+offset | **Implementation gap** — cursor support should be added. Offset-only is acceptable for v1 but cursor is the target. |
| 13 | HIGH | SSE uses `agent.invocation` (not `agent.invoked`), data-only frames | Fixed event kind to `agent.invocation` in § 5.1 |
| 14 | HIGH | Idempotency header not implemented (only webhook dedupe exists) | **Implementation gap** — idempotency middleware is a separate issue (#170). Webhook dedupe is sufficient for v1. |
| 15 | BLOCKING | Internal worker protocol doesn't match actual `QueueJobDataMap` payloads | **Design-forward spec** — § 11 defines the target protocol. Current code uses ad-hoc payloads that should be migrated to this protocol during worker refactoring. |

**Classification note:** Findings marked "Implementation gap" indicate that the spec is intentionally forward-looking. The code should be updated to match this spec, not the reverse. Findings marked with inline fixes have been applied to this document.
