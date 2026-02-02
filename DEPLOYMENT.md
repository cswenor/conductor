# Deployment

> **Design Specification.** This document describes the deployment model for Conductor. Commands and configurations shown are illustrative and not yet implemented. See [README.md](README.md) for current project status.

---

## Principle

Conductor is a **portable control plane** that runs the same way everywhere.

**One service. Two modes. No behavior forks.**

Both modes use the same codebase, same orchestration logic, same guarantees. The only difference is where the host runs.

---

## Deployment Modes

| Mode | Where | For Whom | Default? |
|------|-------|----------|----------|
| **Local** | Your machine | Solo developers, trust building, debugging | ✅ Yes |
| **Remote** | Linux instance | Always-on orchestration, long-running tasks | Advanced |

**Note on "teams":** In v1, remote mode supports always-on single-operator usage. Team visibility happens via GitHub (the collaboration surface). Multi-operator UI with auth/roles comes later.

---

## Two Workflows: Operator vs Host Admin

| Workflow | Who | Where | Examples |
|----------|-----|-------|----------|
| **Operator workflow** | Day-to-day user | UI only | Connect GitHub, add repos, start runs, approve plans |
| **Host admin workflow** | Deployment/ops | Config files, env vars | Set data dir, bind address, secrets, TLS, backups |

**Operator workflow is identical in both modes.** Host admin workflow differs by environment.

---

## Local Mode (Default)

### What It Is

Conductor runs on your personal machine. Repos, worktrees, and dev servers all live locally.

### Operator Workflow (UI)

1. Launch Conductor (serves UI on `localhost:4000`)
2. Open UI → **Projects → Create Project**
3. Connect GitHub (install Conductor GitHub App)
4. Add repos, start runs, approve plans — all in UI

### Host Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | macOS 12+, Linux | macOS 14+, Ubuntu 22.04 |
| RAM | 8GB | 16GB |
| Disk | 10GB free | 50GB free |
| Git | 2.30+ | 2.40+ |

### Webhook Delivery (Local)

Local mode requires webhook delivery from GitHub. Options:

| Strategy | How | Trade-offs |
|----------|-----|------------|
| Tunnel (recommended) | `conductor tunnel` or ngrok-style relay | Real-time events; requires tunnel service |
| Polling fallback | Conductor polls GitHub API | Higher latency; no external dependency |

### GitHub Auth (Local)

| Method | Recommended? | Notes |
|--------|--------------|-------|
| GitHub App | ✅ Yes | Proper scoping, audit trail, rotation |
| PAT | ⚠️ Dev only | Escape hatch for early development; not recommended for regular use |

PAT support exists only as a local development escape hatch. It is not supported in remote mode.

### Local Capabilities

| Capability | Local Mode |
|------------|------------|
| Repo clones | Local filesystem |
| Worktrees | Local filesystem |
| Dev servers | Local ports |
| Database | SQLite |
| UI | `localhost:4000` |
| Persistence | While process runs |

---

## Remote Mode (Advanced)

### What It Is

Conductor runs on a dedicated Linux instance. It stays running continuously, handles long-running tasks, and provides always-on orchestration.

### Operator Workflow (UI)

Same as local mode — all operator actions happen in the UI:

1. Access UI via `https://conductor.your-domain.com`
2. Connect GitHub, add repos, start runs, approve plans

**The operator experience is identical.** Only the host environment differs.

### Host Admin Workflow (Ops)

Host admin configures the server environment:

- Data directory and storage
- Bind address and port
- TLS termination (reverse proxy)
- GitHub App credentials
- Backup/restore procedures

These are deployment concerns, not operator concerns.

### Host Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Ubuntu 22.04, Debian 12 | Ubuntu 24.04 |
| CPU | 2 cores | 4+ cores |
| RAM | 4GB | 8GB+ |
| Disk | 50GB | 100GB+ SSD |
| Network | Public IP or tunnel | Static IP + domain |

### Remote Capabilities

| Capability | Remote Mode |
|------------|-------------|
| Repo clones | Server filesystem |
| Worktrees | Server filesystem |
| Dev servers | Server ports |
| Database | SQLite or PostgreSQL |
| UI | HTTPS via domain |
| Persistence | Always (service) |
| GitHub auth | App only (PAT not supported) |

---

## Security Requirements (Remote)

These are design invariants for remote deployment:

### Network

| Requirement | Invariant |
|-------------|-----------|
| Bind address | Default `127.0.0.1`; explicit config required for `0.0.0.0` |
| TLS | Required for remote; terminate at reverse proxy (nginx, Caddy, etc.) |
| Firewall | Only expose UI port; internal ports (dev servers) not public |

### Authentication

| Requirement | Invariant |
|-------------|-----------|
| UI auth | Single operator token in v1; GitHub OAuth / SSO in future |
| GitHub auth | App-based only; PAT not supported in remote mode |
| Secrets | Injected via environment or file mount; never in config file |

### Audit & Persistence

| Requirement | Invariant |
|-------------|-----------|
| Audit logs | Persisted to database; retention configurable |
| Backups | Regular export of database; worktrees are ephemeral |
| Secrets rotation | GitHub App key rotation supported without downtime |

---

## Host Adapter Architecture

Conductor abstracts host differences through a **Host Adapter** interface:

- Filesystem operations (read, write, mkdir)
- Process execution (spawn, exec)
- Port allocation and release
- Secret retrieval
- Git operations (clone, worktree)

**Key principle:** Orchestration code never branches on mode. The Host Adapter provides the same interface with mode-appropriate implementations.

Both modes use the same config schema; mode only changes defaults.

See [ARCHITECTURE.md](ARCHITECTURE.md) for Host Adapter details.

---

## Configuration

### Config Schema (Both Modes)

```yaml
# Same schema for local and remote; mode changes defaults

mode: local  # or "remote"

# Paths (defaults differ by mode)
data_dir: ~/.conductor/data        # local default
# data_dir: /data/conductor        # typical remote

# Network
host: 127.0.0.1                    # local default (safe)
# host: 0.0.0.0                    # remote requires explicit
port: 4000

# GitHub (App required; PAT only for local dev)
github:
  app_id: 123456
  app_private_key_path: /path/to/key.pem

# Database
database:
  type: sqlite                      # or "postgresql" for remote
  path: ${data_dir}/conductor.db

# Ports for dev servers
port_range:
  start: 3000
  end: 4999
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CONDUCTOR_MODE` | `local` or `remote` | `local` |
| `CONDUCTOR_DATA_DIR` | Data directory | `~/.conductor/data` |
| `CONDUCTOR_HOST` | Bind address | `127.0.0.1` |
| `CONDUCTOR_PORT` | UI port | `4000` |
| `GITHUB_APP_ID` | GitHub App ID | — |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to App private key | — |

---

## Migration: Local → Remote

### Prerequisites

- Remote instance configured and running
- GitHub App webhook URL updated to point to remote instance
- **No active runs** — migration is cold-move only

### Migration Steps

1. **Pause/cancel active runs** — Migration does not support in-flight runs
2. **Export state** — Projects, repos, policies, run history
3. **Transfer to remote** — Import on remote instance
4. **Update GitHub App webhook URL** — Point to remote instance
5. **Verify** — Check GitHub connection, repo access

### What Transfers

| Data | Transfers? | Notes |
|------|------------|-------|
| Projects | ✅ | |
| Repo registrations | ✅ | |
| Policies | ✅ | |
| Run history | ✅ | |
| Worktrees | ❌ | Recreated on demand |
| Repo clones | ❌ | Re-cloned on demand |
| Active runs | ❌ | Must be cancelled before migration |

### Active Run Semantics

Migration only supports **cold move**:
- Active runs must be paused or cancelled before export
- In-flight runs are not resumed on the new host
- After migration, operator restarts work as needed

This simplifies migration and avoids state reconciliation complexity.

---

## What Changes for Operators (Local vs Remote)

| Aspect | Local | Remote |
|--------|-------|--------|
| **Workflow** | Identical | Identical |
| **UI** | `localhost:4000` | `https://your-domain.com` |
| **Availability** | While running | Always-on |
| **Auth** | None (localhost) | Token/OAuth required |
| **TLS** | Not required | Required |
| **GitHub App webhook** | Tunnel or polling | Public endpoint |

**The operator workflow (UI actions) is identical.** Only trust, availability, and infrastructure concerns differ.

---

## Non-Goals

| Non-Goal | Why |
|----------|-----|
| SaaS multi-tenancy | You run it, you control it |
| Kubernetes-native | Keep it simple for v1 |
| Serverless | Needs persistent state |
| Multi-operator auth (v1) | Single operator; team visibility via GitHub |

---

## Future

Post-v1 possibilities (not committed):

- Multi-operator UI with auth/roles
- Remote runners (agents on separate machines)
- Containerized worktrees
- Managed cloud deployment

Core principle remains: **same behavior, different scale**.

---

## Further Reading

- [VISION.md](VISION.md) — Product philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components, Host Adapter details
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — Operator workflows
- [ONBOARDING.md](ONBOARDING.md) — Repository onboarding
