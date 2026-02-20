# Authentication & Authorization

> **Status:** Normative (v0.1 scope). This is the canonical auth specification. All other docs reference this document for auth behavior.

## 1. Principles

1. **GitHub is the identity provider.** Conductor does not maintain its own user/password database. All user identities derive from GitHub OAuth.
2. **Single identity model.** In v0.1, one operator = one GitHub user. Multi-operator teams are deferred to v0.3.
3. **Least privilege by default.** Workers receive scoped, short-lived credentials. Agents never see operator credentials, GitHub tokens, or environment variables.
4. **Validate at the boundary, trust internally.** Auth checks happen at API entry points. Internal service calls between trusted components do not re-authenticate.
5. **Audit everything.** Every authenticated action records `actor_id`, `actor_type`, timestamp, and action details.

---

## 2. Identity Model

### 2.1 User Identity

| Field | Source | Purpose |
| --- | --- | --- |
| `user_id` | GitHub `node_id` (e.g., `U_kgDO...`) | Primary key — immutable, survives username changes |
| `github_id` | GitHub numeric ID | Secondary identifier for API lookups |
| `login` | GitHub username | Display only — never used as key (mutable) |
| `avatar_url` | GitHub profile | UI display |
| `display_name` | GitHub profile `name` field | UI display (fallback to `login`) |

**Critical rule:** Never use `login` as a foreign key or lookup key. Usernames change. Always use `node_id`.

### 2.2 Actor Types

Every action in Conductor is attributed to one of:

| Actor Type | Identity Source | Examples |
| --- | --- | --- |
| `operator` | GitHub OAuth session | Approve plan, cancel run, configure project |
| `agent` | Worker role assignment | Create plan, implement code, review PR |
| `system` | Conductor orchestrator | Phase transitions, gate evaluations, cleanup |

In v0.1, `operator` always resolves to the single authenticated GitHub user. The `actor_type` field is recorded from day one to enable multi-operator auth in v0.3 without schema changes.

### 2.3 Database Schema

```sql
CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,           -- GitHub node_id
  github_id  INTEGER NOT NULL UNIQUE,    -- GitHub numeric ID
  login      TEXT NOT NULL,              -- Display only (mutable)
  avatar_url TEXT,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  session_id            TEXT PRIMARY KEY,         -- Cryptographically random token
  user_id               TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  access_token          TEXT NOT NULL,            -- GitHub OAuth token (encrypted AES-256-GCM)
  token_nonce           TEXT,                     -- AES-GCM nonce
  expires_at            TEXT NOT NULL,            -- Session expiry (default: 30 days)
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_authenticated_at TEXT NOT NULL DEFAULT (datetime('now')),  -- For step-up auth (§ 3.4)
  user_agent            TEXT,                     -- Request forensics
  ip_address            TEXT                      -- Client IP (see Appendix A.19)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

---

## 3. Authentication Flows

### 3.1 GitHub OAuth Login (Primary)

```
Browser                    Conductor                  GitHub
  │                           │                          │
  ├── GET /auth/login ──────► │                          │
  │                           ├── Generate state token ──┤
  │                           │   (HMAC-SHA256 signed,   │
  │                           │    10-min expiry,        │
  │                           │    bound to session)     │
  │ ◄── 302 Redirect ────────┤                          │
  │     to github.com/       │                          │
  │     login/oauth/authorize │                          │
  │                           │                          │
  ├── User authorizes ───────────────────────────────► │
  │                           │                          │
  │ ◄── 302 Redirect ──────────────────────────────────┤
  │     with ?code=&state=   │                          │
  │                           │                          │
  ├── GET /auth/callback ───► │                          │
  │     ?code=&state=        │                          │
  │                           ├── Verify state token ───┤
  │                           │   (HMAC, expiry, replay) │
  │                           │                          │
  │                           ├── POST /access_token ───►│
  │                           │   (exchange code)        │
  │                           │                          │
  │                           │ ◄── access_token ────────┤
  │                           │                          │
  │                           ├── GET /user ─────────────►│
  │                           │   (fetch profile)        │
  │                           │                          │
  │                           │ ◄── user profile ────────┤
  │                           │                          │
  │                           ├── Upsert user record     │
  │                           ├── Create session         │
  │                           ├── Encrypt OAuth token    │
  │                           ├── Set secure cookie      │
  │                           │                          │
  │ ◄── 302 to /dashboard ───┤                          │
  │     Set-Cookie:           │                          │
  │       conductor_session=  │                          │
  │       HttpOnly; Secure;   │                          │
  │       SameSite=Lax;       │                          │
  │       Path=/;             │                          │
  │       Max-Age=2592000     │                          │
  └───────────────────────────┘                          │
```

**OAuth scopes requested:**

| Scope | Purpose |
| --- | --- |
| `read:user` | Access user profile (identity) |
| `user:email` | Access email for notifications |

> Note: Repository access comes from the GitHub App installation, not the OAuth token. The OAuth token is only used for user identity.

**State token security:**
- Signed with `HMAC-SHA256(secret, nonce + timestamp)`
- Contains: random nonce (32 bytes), creation timestamp, redirect URI
- Validated: signature check, 10-minute expiry, single-use (stored and checked against replay)
- Prevents: CSRF, open redirect, replay attacks

### 3.2 Session Management

| Property | Value | Rationale |
| --- | --- | --- |
| **Storage** | Server-side (database) | Token cannot be forged or inspected client-side |
| **Cookie** | `conductor_session` | HttpOnly, Secure, SameSite=Lax |
| **Session TTL** | 30 days | Reasonable for single-operator product |
| **Idle timeout** | None (v0.1) | Single operator; will add in v0.3 |
| **Token format** | 32 bytes, `crypto.randomBytes(32).toString('hex')` | Cryptographically random, 256-bit entropy |
| **Refresh** | `last_used_at` updated on each request | Tracks activity for future idle timeout |

**Session lifecycle:**

| Event | Action |
| --- | --- |
| Login | Create session, set cookie |
| Each request | Validate session (exists, not expired), update `last_used_at` |
| Logout | Delete session from DB, clear cookie |
| Token expired | Delete session, redirect to `/auth/login` |
| Cookie missing | Redirect to `/auth/login` (API: 401) |

### 3.3 API Authentication

| Interface | Auth Method | Token Location |
| --- | --- | --- |
| **Web UI** | Session cookie | `Cookie: conductor_session=<token>` |
| **REST API** | API key or session cookie | `Authorization: Bearer <api_key>` or cookie |
| **WebSocket** | Session cookie on upgrade handshake | Cookie validated during HTTP→WS upgrade (see Appendix A.7) |
| **CLI (OpenClaw)** | API key | Stored in `~/.conductor/config.json` |
| **Webhooks (inbound)** | HMAC signature | `X-Hub-Signature-256` header |
| **MCP tools** | Orchestrator credential proxy | Actor_id for audit; NO session tokens passed (see Appendix A.4) |

**API key management (v0.1):**
- Single operator generates keys via UI: `Settings > API Keys`
- Keys stored hashed (`SHA-256`) in `api_keys` table
- Key format: `cond_<32 random hex chars>` (prefix for easy identification)
- Max 5 active keys per user
- Keys can be revoked individually

```sql
CREATE TABLE api_keys (
  key_id     TEXT PRIMARY KEY,           -- Unique key identifier
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL UNIQUE,       -- SHA-256 hash of the key
  name       TEXT NOT NULL,              -- User-provided label
  last_used  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT                        -- Optional expiry
);
```

### 3.4 Step-Up Authentication

Certain high-risk actions require re-authentication if the session is older than a threshold:

| Action | Step-Up Threshold | Method |
| --- | --- | --- |
| Approve/reject gate (session > 4h old) | 4 hours | Re-authenticate via GitHub OAuth |
| Revoke API key | Always | Confirm password (future) / re-OAuth |
| Delete project | Always | Typed confirmation + re-OAuth |
| Change autonomy level | Always | Re-OAuth |

**Step-up flow:**
1. User attempts action
2. Server checks `session.last_authenticated_at` (see Appendix A.2 for schema)
3. If threshold exceeded: return `403 { error: "step_up_required", redirect: "/auth/step-up" }`
4. Client redirects to step-up page
5. User re-authenticates via GitHub OAuth (same flow as login, but preserves session)
6. `session.last_authenticated_at` updated
7. Original action retried automatically

### 3.5 Email Approval Tokens

For approving gates from email notifications without opening the UI:

| Property | Value |
| --- | --- |
| **Format** | JWT signed with server secret |
| **Payload** | `{ gate_id, user_id, action: "approve", iat, exp }` |
| **Expiry** | 1 hour from generation |
| **Single-use** | Tracked via `used_at` column; second use returns 410 Gone |
| **Bound** | Specific gate ID — cannot be reused for different gates |
| **Flow** | Token resolves to confirmation page — NOT auto-approve |

**Email approval flow:**
1. Gate reaches `waiting` state
2. Notification system generates signed token for each eligible approver
3. Email contains link: `/gates/<gate_id>/approve?token=<jwt>`
4. User clicks link → sees confirmation page with gate details and artifact preview
5. User confirms → token consumed, gate resolved
6. If token expired or already used → error page with link to full UI

---

## 4. Authorization

### 4.1 Authorization Model (v0.1)

v0.1 uses a simple ownership model:

```
canAccessProject(user, project) → boolean
  └── project.user_id === user.user_id
```

Every API route is protected by the `withAuth` middleware, which:
1. Extracts session from cookie or API key from `Authorization` header
2. Resolves to `AuthUser` (user_id, login, avatar_url)
3. Attaches `AuthUser` to request context
4. Returns `401 Unauthorized` if no valid auth found

Entity-level authorization:
- All queries filter by `user_id` (projects, runs, settings)
- `canAccessProject()` is the centralized policy check point
- No implicit "admin" or "superuser" bypass

### 4.2 Future RBAC Model (v0.3 Design Notes)

When multi-operator is added, the model extends to:

| Role | Permissions |
| --- | --- |
| `owner` | Full access, manage members, delete project, change autonomy |
| `operator` | Approve/reject gates, start/cancel runs, view all data |
| `viewer` | Read-only access to runs, analytics, history |

Authorization will check: `canAccessProject(user, project, requiredPermission)`.

This is documented here for schema planning purposes. The `actor_id` field in audit records ensures v0.1 data is compatible with v0.3 RBAC without migration.

### 4.3 Autonomy Levels

Projects have configurable autonomy levels that control which actions require human approval:

| Level | Name | Behavior |
| --- | --- | --- |
| `L0` | Full oversight | Every step requires human approval |
| `L1` | Plan approval | **Default.** Plan gate requires approval; execution proceeds autonomously |
| `L2` | Result review | AI executes fully; human reviews the result before merge |
| `L3` | Exception-based | Fully autonomous; human only involved on errors or policy violations |

Autonomy level is set per-project in project settings. It determines which gates are enforced (see ROUTING_AND_GATES.md § Gate Types).

---

## 5. Credential Management

### 5.1 Credential Types

| Credential | Storage | Used By | Rotation |
| --- | --- | --- | --- |
| **OAuth token** | `sessions.access_token` (encrypted) | User identity verification | On each OAuth login |
| **Session token** | `sessions.session_id` | Request authentication | 30-day expiry, new on login |
| **API key** | `api_keys.key_hash` (hashed) | CLI/API authentication | Manual revocation |
| **AI provider key** | `user_api_keys.api_key` (encrypted) | Worker AI calls | User-managed |
| **GitHub App private key** | File mount or env var | Installation token generation | Manual rotation |
| **GitHub installation token** | Generated on demand (1h TTL) | GitHub API writes | Auto-rotated by GitHub |
| **Database encryption key** | Environment variable | Encrypting stored secrets | Manual rotation |
| **Webhook secret** | Environment variable | Verifying inbound webhooks | Manual rotation |
| **Email token signing key** | Environment variable | Signing approval tokens | Rotation invalidates tokens |

### 5.2 Encryption at Rest

All sensitive credentials stored in the database are encrypted:

| Field | Algorithm | Key Source |
| --- | --- | --- |
| `sessions.access_token` | AES-256-GCM | `DATABASE_ENCRYPTION_KEY` |
| `user_api_keys.api_key` | AES-256-GCM | `DATABASE_ENCRYPTION_KEY` |

Encryption implementation:
- Each value encrypted with a unique random nonce (stored in `*_nonce` column)
- `key_encrypted` flag distinguishes encrypted vs plaintext (migration support)
- `DATABASE_ENCRYPTION_KEY`: 64-character hex string (256 bits), provided via environment variable
- Key rotation: re-encrypt all values with new key (offline migration script)

### 5.3 Worker Credential Resolution

Workers receive credentials at task execution time, not at run creation:

```
Worker claims task
    │
    ├── mode: 'none' (script, tool) → No credentials
    ├── mode: 'ai_provider' → Decrypt user's AI key for configured provider
    └── mode: 'github_installation' → Generate fresh installation token (1h TTL)
```

**Security properties:**
- AI keys are decrypted only at point of use, never cached
- GitHub installation tokens are short-lived (1 hour) and scoped to installation repos
- Missing credentials fail the individual step, not the entire run
- Workers never receive operator session tokens or the database encryption key

See WORKER_CREDENTIALS.md for the full credential resolution flow and per-step requirements.

### 5.4 Secret Protection

Conductor has multi-layer secret protection to prevent credential leakage:

| Layer | Mechanism | Action on Detection |
| --- | --- | --- |
| **Tool arguments** | Policy engine pattern scan | Block (high-confidence) or warn (pattern-only) |
| **Tool results** | Output scan before returning to agent | Redact and warn |
| **GitHub writes** | Content scan before API call | Block write, create PolicyViolation |
| **Log output** | `redact()` at every storage boundary | Redact patterns, record detection |
| **Env injection** | Secrets mounted in worktree env, never in tool output | Prevented by architecture |

**Detection severity:**

| Severity | Trigger Examples | Action |
| --- | --- | --- |
| `block` | `ghp_*`, `gho_*` (GitHub tokens), `AKIA*` (AWS keys), `-----BEGIN` (private keys) | Block execution; `PolicyViolation` record; require operator override |
| `warn` | `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` patterns without format validation | Log warning; redact in storage; allow execution |

---

## 6. Audit Trail

### 6.1 What Is Logged

Every state-changing action records:

| Field | Source | Example |
| --- | --- | --- |
| `actor_id` | Session user_id, worker role, or "system" | `U_kgDO...` |
| `actor_type` | `operator`, `agent`, `system` | `operator` |
| `action` | Operation performed | `gate.approve`, `run.cancel`, `project.create` |
| `target_type` | Entity type | `run`, `gate`, `project` |
| `target_id` | Entity identifier | `run_abc123` |
| `timestamp` | Server-generated | `2026-02-20T14:30:00Z` |
| `metadata` | Action-specific details | `{ gate_version: 3, comment: "LGTM" }` |
| `ip_address` | Request source (v0.1: always `127.0.0.1` for local) | `127.0.0.1` |

### 6.2 GitHub Write Audit

All GitHub writes additionally record:

| Field | Purpose |
| --- | --- |
| `idempotency_key` | Prevent duplicate writes on retry |
| `write_kind` | `comment`, `check_run`, `project_field`, etc. |
| `target_node_id` | GitHub node_id of the target entity |
| `payload_hash` | SHA-256 of the write payload |
| `policy_decision` | Did the write pass policy? Any warnings? |
| `status` | `pending`, `completed`, `failed`, `skipped` |

### 6.3 Retention

| Data | Retention | Rationale |
| --- | --- | --- |
| Audit log entries | Indefinite (v0.1) | Compliance, debugging |
| Session records | Deleted on expiry + 7 days | Privacy |
| Revoked API keys | Soft-deleted, retained 90 days | Forensics |
| GitHub write records | Indefinite | Audit trail matches GitHub |

---

## 7. Environment Variables

All auth-related configuration:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | Yes | — | GitHub App identifier |
| `GITHUB_APP_PRIVATE_KEY` | Yes | — | GitHub App private key (PEM format) |
| `GITHUB_CLIENT_ID` | Yes | — | OAuth application client ID |
| `GITHUB_CLIENT_SECRET` | Yes | — | OAuth application client secret |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | HMAC secret for webhook verification |
| `DATABASE_ENCRYPTION_KEY` | Yes (production) | — | 64-char hex for AES-256-GCM |
| `SESSION_SECRET` | Yes | — | HMAC key for state token signing |
| `EMAIL_TOKEN_SECRET` | Yes | — | JWT signing key for approval tokens |
| `ANTHROPIC_API_KEY_OVERRIDE` | No | — | Dev override for AI provider key |
| `OPENAI_API_KEY_OVERRIDE` | No | — | Dev override for AI provider key |
| `BASE_URL` | Yes (production) | `http://localhost:3000` (dev only) | OAuth callback URL; MUST be `https://` in production (see A.20) |
| `CONDUCTOR_OWNER_GITHUB_ID` | Yes (remote) | — | GitHub numeric ID of instance owner (see A.5) |
| `TRUSTED_PROXIES` | No | — | CIDR ranges for reverse proxy IP trust (see A.19) |
| `JOB_SIGNING_KEY` | Yes | — | HMAC key for signed job envelopes (see A.14) |

---

## 8. Security Invariants

These must hold at all times:

1. **No unauthenticated access.** Every API route (except `/auth/*` and health checks) requires valid session or API key.
2. **No credential exposure to agents.** Workers never receive session tokens, OAuth tokens, database encryption keys, or webhook secrets. They receive only scoped, per-task credentials.
3. **No GitHub writes without policy check.** All GitHub API calls go through the policy engine, which checks content, rate limits, and target scope.
4. **Append-only audit.** Audit log entries are never updated or deleted. Conductor's GitHub comments are never edited or deleted (new comments for updates).
5. **Encrypted at rest.** All stored secrets (OAuth tokens, AI keys) are encrypted with AES-256-GCM. The encryption key is never stored in the database.
6. **Session-scoped access.** API queries filter by `user_id` from the authenticated session. No query ever returns another user's data (enforced at the query layer, not just the API layer).

---

## 9. Cross-References

| Topic | Document |
| --- | --- |
| Worker credential resolution flow | `docs/WORKER_CREDENTIALS.md` |
| GitHub App permissions | `docs/INTEGRATION_MODEL.md` § Permissions |
| GitHub write policy | `docs/ARCHITECTURE.md` § GitHub Write Policy |
| Secret detection patterns | `docs/POLICIES.md` § Secret Detection |
| Gate approval auth | `docs/ui/CONTROL_PLANE_UX_V3.md` § A.5 |
| Trust boundaries | `docs/ARCHITECTURE.md` § Trust Boundaries |
| Event audit schema | `docs/PROTOCOL.md` § Event Schema |
| Autonomy levels | `docs/orchestrator/INTERFACES.md` § Autonomy Level Controls |

---

## Appendix A: Security Review Resolutions

This section addresses findings from adversarial security review of this specification.

### A.1 OAuth State Token Signing (BLOCKING #1)

**Problem:** State token signing payload was underspecified.

**Resolution — Canonical state token format:**

```
state_payload = {
  nonce: crypto.randomBytes(32),          // Random per-request
  iat: Math.floor(Date.now() / 1000),     // Creation timestamp
  redirect_uri: '/dashboard',             // Exact callback redirect
  pre_auth_session_id: crypto.randomUUID() // Binds to pre-auth session
}
signature = HMAC-SHA256(SESSION_SECRET, JSON.stringify(state_payload))
state = base64url(JSON.stringify(state_payload)) + '.' + base64url(signature)
```

**Verification on callback:**
1. Split state, verify HMAC signature against payload
2. Check `iat` not older than 10 minutes
3. Check `pre_auth_session_id` exists in server-side store and is unused
4. Mark `pre_auth_session_id` as consumed (prevents replay)
5. Verify `redirect_uri` matches an allowlist (prevents open redirect)

### A.2 Session Schema: last_authenticated_at (BLOCKING #2)

**Problem:** Step-up auth references `session.last_authenticated_at` but the column was missing from schema.

**Resolution — Updated sessions table:**

```sql
CREATE TABLE sessions (
  session_id            TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  access_token          TEXT NOT NULL,          -- Encrypted AES-256-GCM
  token_nonce           TEXT,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_authenticated_at TEXT NOT NULL DEFAULT (datetime('now')),  -- Updated on login + step-up
  user_agent            TEXT,                   -- Request User-Agent (forensics)
  ip_address            TEXT                    -- Client IP (forensics)
);
```

`last_authenticated_at` is set on initial login and updated on each step-up re-authentication.

### A.3 Email Token Step-Up Equivalence (BLOCKING #3)

**Problem:** Email approval tokens could bypass step-up auth requirements.

**Resolution:** Email token redemption IS the step-up equivalent. The token itself is:
- Short-lived (1h), single-use, bound to specific gate
- Signed with a dedicated secret (not the session secret)
- Requires confirmation page interaction (not auto-approve)

The confirmation page flow:
1. User clicks email link → lands on `/gates/:id/approve?token=<jwt>`
2. Server validates JWT (signature, expiry, `jti` not consumed, gate_id match)
3. If user has active session → show confirmation page
4. If user has no active session → redirect to OAuth login, then back to confirmation
5. Confirmation page requires explicit button click → POST with consumed `jti`

**Rule:** Email tokens never bypass the requirement for an authenticated session. The token authorizes viewing the confirmation page; the session authorizes the action.

### A.4 MCP Tool Credential Isolation (BLOCKING #4)

**Problem:** "Inherited from host session" for MCP tools could imply agents receive operator credentials.

**Resolution — Clarification:** MCP tools do NOT receive operator session tokens. The inheritance model is:

```
Operator session → Orchestrator context → Worker task assignment
                                            │
                                            ├── actor_id (for audit attribution)
                                            ├── project_id (for scope enforcement)
                                            └── NO session token, NO OAuth token
```

The orchestrator resolves credentials server-side based on the task requirements:
- `ai_provider` → orchestrator decrypts user's AI key, passes to worker
- `github_installation` → orchestrator generates installation token, passes to worker
- Tools → orchestrator executes tool server-side with its own credentials; agent receives only results

**Agents never hold operator credentials.** The orchestrator acts as credential proxy.

### A.5 Operator Bootstrap (BLOCKING #5)

**Problem:** First-login-takes-all is an account takeover risk on exposed deployments.

**Resolution — Bootstrap trust model:**

| Mode | Bootstrap Mechanism |
| --- | --- |
| **Local (default)** | First OAuth login becomes owner. Binding address `127.0.0.1` prevents external access. |
| **Remote** | `CONDUCTOR_OWNER_GITHUB_ID` env var required. Only this GitHub user can complete first login. |

```
# Remote deployment requires explicit owner declaration
CONDUCTOR_OWNER_GITHUB_ID=12345678  # GitHub numeric ID of intended owner
```

**Bootstrap sequence:**
1. First request to `/auth/login` checks if `users` table is empty
2. If empty AND remote mode: verify `github_id` from OAuth matches `CONDUCTOR_OWNER_GITHUB_ID`
3. If match: create user, mark as owner
4. If mismatch: reject with "This Conductor instance has a configured owner"
5. If local mode: first login succeeds (localhost-only access is the trust boundary)

### A.6 CSRF Protection (HIGH #6)

**Resolution:** All cookie-authenticated mutating endpoints require CSRF protection:

| Method | CSRF Requirement |
| --- | --- |
| GET, HEAD, OPTIONS | None |
| POST, PUT, PATCH, DELETE | `Origin` header must match `BASE_URL`, OR `X-CSRF-Token` header must match server-generated token |

**Implementation:**
- Double-submit cookie pattern: server sets `conductor_csrf` cookie (non-HttpOnly), client reads and sends as `X-CSRF-Token` header
- Alternatively: strict `Origin` / `Referer` validation against `BASE_URL`
- API key-authenticated requests are exempt (not cookie-based, not vulnerable to CSRF)

### A.7 WebSocket Authentication (HIGH #7)

**Problem:** Sending session token in WebSocket message exposes it to JavaScript.

**Resolution — Cookie-based WebSocket auth:**

```
Browser                         Server
  │                                │
  ├── WS Upgrade Request ────────►│
  │   Cookie: conductor_session=  │
  │   Origin: https://conductor   │
  │                                │
  │                                ├── Validate cookie (same as HTTP)
  │                                ├── Validate Origin header
  │                                ├── Bind WS to user_id
  │                                │
  │ ◄── 101 Switching Protocols ──┤
  │                                │
  │ ◄── { type: "authenticated",  │
  │       user_id: "..." } ───────┤
```

**Rules:**
- WebSocket authenticates via existing session cookie on HTTP upgrade handshake
- `Origin` header MUST match `BASE_URL` (reject cross-origin WS connections)
- No session tokens sent over the WS channel itself
- Server validates session on each inbound message (or at minimum every 60s)
- On session expiry/revocation: server closes WS with code 4001 ("session_expired")
- On logout: server closes all WS connections for that user

### A.8 API Key Brute Force Protection (HIGH #8)

**Resolution:**

| Control | Threshold | Action |
| --- | --- | --- |
| Per-IP rate limit | 10 failed attempts / minute | Block IP for 15 minutes |
| Per-user rate limit | 5 failed attempts / 5 minutes | Lock user auth for 30 minutes |
| Global alert | 50 failed attempts / hour | Operator notification |
| Backoff | Exponential (1s, 2s, 4s, 8s, max 30s) | Applied per-IP after 3rd failure |

All failed authentication attempts are logged to audit with `action: "auth.failed"`.

### A.9 Timing-Safe Key Verification (HIGH #9)

**Resolution:** API key verification MUST use constant-time comparison:

```typescript
import { timingSafeEqual } from 'crypto';

function verifyApiKey(providedKey: string, storedHash: string): boolean {
  const providedHash = sha256(providedKey);
  // Both buffers must be same length for timingSafeEqual
  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

All auth failure responses MUST return identical error shape and timing regardless of failure reason (unknown key vs wrong key vs expired key).

### A.10 CLI Key Storage (HIGH #10)

**Resolution — Key storage hierarchy:**

1. **OS keychain** (preferred): `security` (macOS), `secret-tool` (Linux), Credential Manager (Windows)
2. **File fallback**: `~/.conductor/credentials.json` with `0600` permissions
3. **Environment variable**: `CONDUCTOR_API_KEY` (for CI/automation)

CLI checks permissions on startup. If credentials file is world-readable (`0644` or broader), CLI refuses to start and prints: "Credentials file has insecure permissions. Run: chmod 600 ~/.conductor/credentials.json"

### A.11 Email JWT Security (HIGH #11)

**Resolution — JWT requirements:**

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
{
  "iss": "conductor",
  "aud": "gate-approval",
  "sub": "<user_id>",
  "jti": "<unique-token-id>",
  "gate_id": "<gate_id>",
  "action": "approve",
  "iat": 1708444800,
  "exp": 1708448400
}
```

**Validation rules:**
- Algorithm MUST be `HS256` (reject `none`, `RS256`, etc.)
- `iss` MUST be `"conductor"`
- `aud` MUST be `"gate-approval"`
- `jti` checked against `email_tokens` table (single-use enforcement)
- `gate_id` MUST match the gate in the URL path
- `exp` MUST be in the future

### A.12 Email Token URL Leakage (HIGH #12)

**Problem:** Token in query string leaks via browser history, logs, Referer.

**Resolution:** Two-step token redemption:

1. Email link contains short opaque code: `/gates/:id/verify?code=<random-32-hex>`
2. Code maps to JWT in `email_tokens` table (1h TTL)
3. Landing page loads, exchanges code for gate details via POST (`Referrer-Policy: no-referrer`)
4. Code is consumed on first POST (even if user doesn't complete approval)
5. If code expired/consumed: error page with link to full UI

Headers on token landing page:
```
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
Cache-Control: no-store
```

### A.13 Email Token Atomic Consumption (HIGH #13)

**Resolution:** Token consumption uses atomic SQL:

```sql
UPDATE email_tokens
SET used_at = datetime('now'), used_by_session = ?
WHERE jti = ? AND used_at IS NULL
RETURNING gate_id, user_id, action;
```

If `RETURNING` returns zero rows, the token was already consumed → return `410 Gone`. This is a single atomic operation — no read-then-write race.

### A.14 Service-to-Service Auth (HIGH #14)

**Problem:** "Trust internally" is too broad for multi-process queue architecture.

**Resolution — Job envelope integrity:**

All job messages in the BullMQ queue include a signed envelope:

```typescript
interface SignedJobEnvelope {
  job_id: string;
  run_id: string;
  task_slug: string;
  actor_id: string;          // Who initiated (for audit)
  credential_scope: string;  // What credentials the worker may request
  created_at: string;
  signature: string;         // HMAC-SHA256(JOB_SIGNING_KEY, canonical(payload))
}
```

Workers verify the signature before executing. This prevents:
- Queue poisoning (malicious job injection)
- Privilege escalation (modifying `credential_scope` in transit)
- Actor spoofing (changing `actor_id`)

`JOB_SIGNING_KEY` is a separate env var from other secrets.

### A.15 Environment Variable Clarification (HIGH #15)

**Problem:** AUTH says agents never see env vars; INTEGRATION_MODEL says secrets mounted in worktree env.

**Resolution — Two distinct environments:**

| Environment | Who Sees It | What's In It |
| --- | --- | --- |
| **Host process env** | Conductor server only | `DATABASE_ENCRYPTION_KEY`, `SESSION_SECRET`, `GITHUB_APP_PRIVATE_KEY`, etc. |
| **Worktree execution env** | Agent/worker process | `HOME`, `PATH`, `NODE_ENV`, `PORT` — NO secrets |

Secrets needed by workers (AI keys, GitHub tokens) are passed via the task payload (encrypted in transit, decrypted by worker at point of use), never via environment variables in the worktree shell.

The INTEGRATION_MODEL phrase "secrets mounted in worktree env" is **incorrect** and should be updated to: "scoped credentials passed in task payload."

### A.16 Session Hardening (MEDIUM #16)

**Resolution:**

| Control | v0.1 Behavior | v0.3 Plan |
| --- | --- | --- |
| **Session rotation** | New session ID on login and step-up | Same |
| **Idle timeout** | None (single operator) | 2 hours configurable |
| **Concurrent sessions** | Unlimited (single operator) | Max 5 per user |
| **Session listing** | Not exposed | UI: "Active Sessions" with revoke |

Session ID rotation on step-up prevents session fixation through re-auth flows.

### A.17 API Key Revocation Schema (MEDIUM #17)

**Resolution — Updated api_keys table:**

```sql
CREATE TABLE api_keys (
  key_id     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  last_used  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,                -- NULL = active; set = revoked
  revoked_by TEXT                 -- user_id of revoker (for multi-operator audit)
);
```

Revoked keys remain in the table for 90 days (forensics), then are hard-deleted by the janitor process.

### A.18 Auth Audit Matrix (MEDIUM #18)

**Resolution — Mandatory auth event logging:**

| Event | Logged Fields | Always Logged? |
| --- | --- | --- |
| `auth.login.success` | user_id, ip, user_agent | Yes |
| `auth.login.failure` | attempted_login, ip, user_agent, reason | Yes |
| `auth.callback.failure` | ip, reason (invalid state, expired, replay) | Yes |
| `auth.logout` | user_id, session_id | Yes |
| `auth.session.expired` | user_id, session_id | Yes |
| `auth.apikey.failure` | ip, key_prefix (first 8 chars), reason | Yes |
| `auth.apikey.created` | user_id, key_id, key_name | Yes |
| `auth.apikey.revoked` | user_id, key_id, revoked_by | Yes |
| `auth.stepup.required` | user_id, action, session_age | Yes |
| `auth.stepup.success` | user_id, action | Yes |
| `auth.stepup.failure` | user_id, ip, reason | Yes |
| `auth.email_token.consumed` | user_id, gate_id, jti | Yes |
| `auth.email_token.expired` | gate_id, jti | Yes |
| `auth.email_token.replay` | gate_id, jti, ip | Yes |

### A.19 IP Address Recording (MEDIUM #19)

**Problem:** `127.0.0.1` for local mode makes forensics ineffective in remote.

**Resolution:**

| Mode | IP Source |
| --- | --- |
| **Local** | `req.socket.remoteAddress` (always `127.0.0.1`, acceptable) |
| **Remote** | `X-Forwarded-For` via trusted proxy, validated against `TRUSTED_PROXIES` allowlist |

```
# Remote deployment
TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12  # Only trust these reverse proxy IPs
```

If `TRUSTED_PROXIES` is not set in remote mode, Conductor logs a startup warning: "No trusted proxies configured. Client IP logging will be inaccurate."

Additionally, `user_agent` and a `request_id` (UUID v7) are recorded with every audit entry.

### A.20 BASE_URL Production Requirement (MEDIUM #20)

**Resolution:** `BASE_URL` is **required** when `NODE_ENV=production`:

| Environment | BASE_URL | Behavior |
| --- | --- | --- |
| `development` | Optional (defaults to `http://localhost:3000`) | HTTP allowed |
| `production` | **Required** | Must start with `https://`. Startup fails if missing or HTTP. |

OAuth callback URL is constructed as `${BASE_URL}/auth/callback` — this must exactly match the GitHub App's configured callback URL.

### A.21 Encryption Migration Guard (MEDIUM #21)

**Resolution:** On startup in production mode, Conductor checks for unencrypted secrets:

```sql
SELECT COUNT(*) FROM user_api_keys WHERE key_encrypted = 0;
SELECT COUNT(*) FROM sessions WHERE token_nonce IS NULL;
```

If any unencrypted records exist in production: **startup fails** with error:
"Unencrypted secrets detected in database. Run `conductor migrate-encryption` before starting in production mode."

### A.22 Auth Precedence (MEDIUM #22)

**Resolution — Deterministic auth precedence:**

1. `Authorization: Bearer <token>` header → API key auth
2. `Cookie: conductor_session=<token>` → Session auth
3. Both present → API key wins (Bearer header takes precedence)

Mixed credentials are allowed but the higher-precedence method determines the authenticated identity. The audit record includes `auth_method: "api_key" | "session"` to distinguish.

### A.23 Execution Mode Taxonomy (MEDIUM #23)

**Resolution:** Two related but distinct enums:

| Enum | Where Used | Values |
| --- | --- | --- |
| `ExecutionMode` | Worker/step configuration | `ai_agent`, `script`, `tool`, `github_api` |
| `CredentialMode` | Credential resolution | `none`, `ai_provider`, `github_installation` |

Mapping:

| ExecutionMode | CredentialMode |
| --- | --- |
| `ai_agent` | `ai_provider` |
| `script` | `none` |
| `tool` | `none` |
| `github_api` | `github_installation` |

Both enums are valid and serve different purposes. WORKER_CREDENTIALS.md uses `CredentialMode` (what credentials to resolve); step configuration uses `ExecutionMode` (how to execute).

### A.24 API Key Scoping (SUGGESTION #24)

**v0.1:** All API keys have full access (same as operator session). Acceptable for single-operator.

**v0.3 design note:** Keys will support scopes:

| Scope | Permissions |
| --- | --- |
| `read` | GET endpoints only |
| `run:control` | Start, pause, cancel runs |
| `admin` | All operations including project settings |

Schema addition: `scope TEXT NOT NULL DEFAULT 'admin'` on `api_keys` table.

### A.25 Cookie Hardening (SUGGESTION #25)

**Resolution:** Use `__Host-` prefix for maximum cookie security:

```
Set-Cookie: __Host-conductor_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
```

`__Host-` prefix enforces: `Secure` flag required, no `Domain` attribute, `Path=/` required. Browsers that support the prefix get hardened behavior; older browsers treat it as a normal cookie name.

**Exception:** OAuth callback flow may need a separate non-`__Host-` state cookie if cross-origin redirects are involved. Document explicitly.

### A.26 Clickjacking Protection (SUGGESTION #26)

**Resolution:** All responses include anti-clickjacking headers:

```
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
```

For approval confirmation pages specifically, these headers are critical — an attacker could frame the confirmation page to trick an operator into approving a malicious gate.
