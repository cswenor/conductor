# Onboarding

This document describes how Conductor onboards a repository. The goal is **point and go**: add a repo in the UI, and you're ready to start working.

---

## The Promise

**Onboarding is a control-plane action.** It happens in the UI, not via CLI.

1. Open Conductor UI → **Projects**
2. Click **Add Repo**
3. Select repos from your connected GitHub org

Conductor clones your repo, analyzes it, detects your stack, and registers it in its database. No changes to your repository. No PR required. No configuration files.

---

## What Onboarding Does

### 1. Clone and Analyze

Conductor clones the repository and analyzes it to understand:

| Detection | How | Why |
|-----------|-----|-----|
| **Language/Runtime** | Package files, extensions, shebang | Choose correct profile |
| **Package Manager** | Lock files (pnpm-lock, yarn.lock, etc.) | Run correct install commands |
| **Test Command** | package.json scripts, pytest.ini, Makefile | Configure test gate |
| **Lint Command** | Same sources | Configure lint gate |
| **Build Command** | Same sources | Understand build requirements |
| **Dev Server** | package.json scripts, framework detection | Configure dev environment |
| **Repo Structure** | Directory layout | Detect monorepo, identify entry points |

Detection is heuristic but conservative. If unsure, Conductor uses safe defaults that you can customize later through the UI.

### 2. Select Profile

Based on detection, Conductor selects a **profile**—a preset configuration for common repo types.

| Profile | Detected By | Defaults |
|---------|-------------|----------|
| `node-npm` | package-lock.json | npm test, npm run lint |
| `node-pnpm` | pnpm-lock.yaml | pnpm test, pnpm lint |
| `node-yarn` | yarn.lock | yarn test, yarn lint |
| `nextjs` | next.config.* | pnpm dev, port 3000 |
| `python-pytest` | pytest.ini, pyproject.toml | pytest, ruff |
| `python-poetry` | poetry.lock | poetry run pytest |
| `go-standard` | go.mod | go test ./..., golangci-lint |
| `rust-cargo` | Cargo.toml | cargo test, cargo clippy |
| `monorepo-turbo` | turbo.json | turbo run test, workspace detection |
| `monorepo-nx` | nx.json | nx affected:test |
| `generic` | Fallback | Manual configuration required |

Profiles are starting points. Everything is customizable in Conductor's UI after registration.

### 3. Store Configuration

Conductor stores all configuration in its database—not in your repository:

```yaml
# Stored in Conductor DB (not in repo)
repo:
  owner: acme
  name: webapp
  profile: nextjs

runtime:
  language: node
  version: "20"
  package_manager: pnpm

commands:
  install: pnpm install
  test: pnpm test
  lint: pnpm lint
  build: pnpm build
  dev: pnpm dev

dev_server:
  command: pnpm dev
  port: 3000
  health_check: http://localhost:${PORT}/
  ready_pattern: "ready started"

gates:
  tests_pass:
    command: pnpm test
    required: true
  lint_pass:
    command: pnpm lint
    required: false
```

### 4. Verify GitHub Access

Conductor verifies it can work with the repository:

| Check | Required? | What It Checks |
|-------|-----------|----------------|
| GitHub App installed | Yes | App has required permissions |
| Repository accessible | Yes | Can clone and read contents |
| Default branch exists | Yes | main/master is valid |
| Can create branches | Yes | Can push worktree branches |
| Can create PRs | Yes | Has pull request permissions |
| Can post comments | Yes | Has issue/PR comment permissions |

### 5. Index Codebase

Conductor indexes your codebase for agent context:

- File structure and important paths
- Entry points and module boundaries
- Recent commits and active areas
- Existing patterns and conventions

This index lives in Conductor's database and is refreshed when runs start.

### 6. Ready to Work

That's it. The repo is registered and ready:

```
✅ Repository registered: acme/webapp
   Profile: nextjs
   Test command: pnpm test
   Lint command: pnpm lint

Open Conductor UI to start working on issues.
```

---

## UI Onboarding Flow

### Add Repo (Primary Path)

1. Navigate to **Projects → [Your Project] → Repos**
2. Click **Add Repo**
3. Select Project (or create new)
4. Choose GitHub org from connected accounts
5. Select one or more repos (multi-select supported)
6. Review detected profile for each repo
7. Click **Register**

### Verify Repo

After registration, the repo detail page shows verification status:

- ✅ GitHub App: installed with correct permissions
- ✅ Repository: accessible, can clone
- ✅ Profile: detected (e.g., nextjs)
- ✅ Test command: detected and working
- ✅ Dev server: configured

### Update Repo Settings

From the repo detail page:
- Re-detect settings (re-analyze repository)
- Override specific settings (test command, profile, etc.)
- Configure policies and gates

### Optional CLI (Advanced)

A CLI may exist for scripted/headless operations but is not the primary interface. All onboarding actions are available in the UI.

---

## Configuration in Conductor UI

All configuration is managed through Conductor's UI, not files in your repo.

### Repo Settings Screen

```
┌─────────────────────────────────────────────────────────────┐
│ Repository: acme/webapp                                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Profile: [nextjs ▼]                                         │
│                                                              │
│ Commands                                                     │
│ ─────────                                                   │
│ Install:  [pnpm install        ]                            │
│ Test:     [pnpm test           ]                            │
│ Lint:     [pnpm lint           ]                            │
│ Build:    [pnpm build          ]                            │
│ Dev:      [pnpm dev            ]                            │
│                                                              │
│ Dev Server                                                   │
│ ──────────                                                  │
│ Port:         [3000  ]                                      │
│ Health check: [http://localhost:3000/]                      │
│ Ready pattern:[ready started         ]                      │
│                                                              │
│ Gates                                                        │
│ ─────                                                       │
│ ☑ Tests pass (required)                                     │
│ ☐ Lint pass (optional)                                      │
│ ☑ Build succeeds (required)                                 │
│                                                              │
│ Policies                                                     │
│ ────────                                                    │
│ Protected paths: [.github/workflows/**]  [+ Add]            │
│ Sensitive paths: [src/auth/**]           [+ Add]            │
│                                                              │
│                              [Save Changes]  [Reset]        │
└─────────────────────────────────────────────────────────────┘
```

### Agent Prompts

Customize agent behavior per-repo through the UI:

```
┌─────────────────────────────────────────────────────────────┐
│ Agent Prompts: acme/webapp                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ [Planner] [Implementer] [Reviewer]                          │
│                                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ # Reviewer Agent - acme/webapp                          │ │
│ │                                                         │ │
│ │ Pay special attention to:                               │ │
│ │ - SQL injection vulnerabilities                         │ │
│ │ - Authentication/authorization checks                   │ │
│ │ - Performance implications of database queries          │ │
│ │                                                         │ │
│ │ Our coding standards:                                   │ │
│ │ - Use TypeScript strict mode                            │ │
│ │ - Prefer functional components                          │ │
│ │ - Always add error boundaries                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│                              [Save]  [Reset to Default]     │
└─────────────────────────────────────────────────────────────┘
```

---

## Why No Config Files in Repos?

Conductor is an **external control plane**. Your repositories stay clean:

| Traditional Approach | Conductor Approach |
|---------------------|-------------------|
| `.conductor/` directory in every repo | Configuration in Conductor DB |
| Config changes require PRs | Config changes instant in UI |
| Different versions across repos | Consistent configuration |
| Config drift and merge conflicts | Single source of truth |
| Repo-specific setup docs | Self-documenting UI |

Benefits:
- **No repo pollution** — Your repos stay focused on your code
- **Instant changes** — Update config without commits or PRs
- **Cross-repo consistency** — Project-level defaults inherited
- **Works with any repo** — Even repos you don't control
- **Simpler onboarding** — No PR to merge, no files to understand

---

## What Conductor Needs

### Repository Requirements

| Requirement | Why | If Missing |
|-------------|-----|------------|
| Git repository | Worktrees, branches | Error |
| GitHub hosted | App, API, Projects | Error |
| Accessible to GitHub App | Permissions | Error with instructions |

### Optional (Recommended)

| Feature | Why | If Missing |
|---------|-----|------------|
| Test command | Test gate validation | Gate can be disabled |
| Lint command | Lint gate validation | Gate can be disabled |
| CI workflow | Pattern reference | Conductor works independently |

### Permissions

Conductor's GitHub App needs:

| Permission | Scope | Why |
|------------|-------|-----|
| `contents:read` | Repository | Clone, read files |
| `contents:write` | Repository | Create branches, push commits |
| `issues:write` | Repository | Post comments, manage state |
| `pull_requests:write` | Repository | Create and update PRs |
| `checks:write` | Repository | Report agent status (status reporting via API, not workflow mutation) |

---

## Troubleshooting

### "Repository not accessible"

Conductor can't access the repository.

**Fix:**
1. Verify the GitHub App is installed: Settings → Integrations → Conductor
2. Check repository permissions include the repo
3. For private repos, ensure App has access

### "Test command not found"

Conductor couldn't detect a test command.

**Fix:** Specify manually in Conductor UI under **Repo Settings → Commands → Test**

### "Profile not detected"

Conductor couldn't determine the repository type.

**Fix:** Select profile in Conductor UI under **Repo Settings → Profile**

### "GitHub App not installed"

The Conductor GitHub App isn't installed on this repository.

**Fix:** Install the app at the installation URL shown in the error, then retry adding the repo in the UI.

---

## Security Model

### What Conductor Accesses

- Repository contents (to analyze and work on)
- Issue contents (to understand tasks)
- PR contents (to create and update)

### What Conductor Stores

- Detected configuration (commands, paths, profiles)
- Custom settings you configure
- Run history and audit logs
- Indexed codebase structure

### What Conductor Never Does

- Modify your repository without creating a branch/PR
- Store credentials or secrets from your repo
- Access repositories without explicit App installation
- Share data between unrelated projects

### You Control Everything

- Revoke access anytime via GitHub App settings
- Delete repo from Conductor to remove all stored data
- Audit all Conductor actions in run logs
- All code changes go through PRs you control

---

## Further Reading

- [VISION.md](VISION.md) — What Conductor is and why
- [PROJECTS.md](PROJECTS.md) — Multi-tenant projects, repos, and work items
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components and data flow
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema and entity relationships
- [INTEGRATION_MODEL.md](INTEGRATION_MODEL.md) — GitHub App integration details
