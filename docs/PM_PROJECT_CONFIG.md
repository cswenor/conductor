# Project Configuration

This file configures project-specific settings for the PM toolkit skills.
Edit this file to match your project's documentation structure, tech stack, and services.

---

## Area Documentation

Maps area labels to documentation files Claude should load when working on issues in that area.

| Label            | Docs to Load                          |
| ---------------- | ------------------------------------- |
| `area:frontend`  | `docs/development/LOCAL_DEV.md`       |
| `area:backend`   | `docs/architecture/DATABASE.md`       |
| `area:infra`     | `docs/ENV_WORKFLOW.md`                |

> Add or remove rows to match your project's area labels and documentation structure.
> Each doc path is relative to the repo root. Multiple docs can be comma-separated.

---

## Keyword Documentation

Maps keywords found in issue bodies/comments to documentation files Claude should load for context.

| Keywords                          | Docs to Load                              |
| --------------------------------- | ----------------------------------------- |
| env, environment, secrets, .env   | `docs/ENV_WORKFLOW.md`, `docs/SECRETS.md` |
| database, postgres, sql           | `docs/architecture/DATABASE.md`           |
| test, testing                     | `docs/development/TESTING.md`             |
| deploy, production, release       | `docs/runbooks/DEPLOY.md`                 |

> Add rows for domain-specific keywords in your project.
> Example: `api, endpoint, rest` → `docs/API_REFERENCE.md`

---

## Library Documentation (context7)

Maps keywords to libraries that Claude should query via context7 MCP for up-to-date documentation.

| Keywords                 | Library to Query |
| ------------------------ | ---------------- |
| vitest                   | vitest           |
| playwright               | playwright       |

> Add rows for your project's key dependencies.
> Examples:
>   `react, jsx, hooks` → `react`
>   `nextjs, next, app router` → `nextjs`
>   `express, middleware` → `express`
>   `svelte, sveltekit` → `sveltekit`
>   `django, views` → `django`
>   `fastapi, pydantic` → `fastapi`

---

## Worktree Port Services

Defines which services get offset ports when running in git worktrees for parallel development.
Each service gets `base_port + offset` where offset is calculated from the issue number.

| Service              | Base Port | Environment Variable |
| -------------------- | --------- | -------------------- |
| Dev server           | 3000      | DEV_PORT             |
| Database             | 5432      | DB_PORT              |

> Add rows for each service that needs port isolation in parallel worktrees.
> Examples:
>   `Redis`     | `6379` | `REDIS_PORT`
>   `API server` | `8080` | `API_PORT`
>   `Storybook`  | `6006` | `STORYBOOK_PORT`
>
> The offset formula is: (issue_number % 79) * 100 + 3200
> Override with WORKTREE_PORT_OFFSET env var if needed.

---

## Worktree URL Exports

Additional environment variables derived from port offsets.
These are exported when `worktree-setup.sh --print-env` is called.

```bash
# Example: if your dev server URL needs to be set
# export SITE_URL=http://localhost:$DEV_PORT
# export API_URL=http://localhost:$API_PORT
```

> Uncomment and customize the exports above for your project's URL-based env vars.

---

## Review Examples

Domain-specific examples used in `/pm-review` to illustrate review principles.
Replace these with examples relevant to your project's technology and failure modes.

### Scope Verification Example

```
WRONG reasoning: "<dependency> handles <feature>, so criterion is met"
RIGHT reasoning: "Line 45 of <file> calls <function> which does <thing>, tested in <test-file> line 120"
```

### Failure Mode Example

```
Common failure mode: Verifying the happy path works but not asking
"what if <resource> doesn't exist yet?" — which would cause a runtime error.
```

### Infra Change Example

```
PR upgraded <service> to :latest. Reviewer noted it as "non-blocking observation".
Correct action: Flag :latest as a reproducibility risk and verify downstream effects.
```

---

## Stakeholder Context (Weekly Reports)

Guidance for translating technical work into stakeholder-friendly language.

### Product Framing

```
Translate technical terms for stakeholders:
- "<internal name>" → "<user-facing description>"
```

### Progress Questions

When reporting on progress, always address these stakeholder questions:

- When will users be able to use the core feature?
- What's the timeline to production readiness?

> Customize these questions based on what your stakeholders care about.
