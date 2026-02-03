# Worker Credentials

## Overview

Conductor workers execute various job types, each with different credential requirements:

| Execution Mode | Example Steps | Credentials Needed |
|----------------|---------------|-------------------|
| `ai_agent` | planner, reviewer, implementer | AI provider key (anthropic, openai, etc.) |
| `script` | lint, test, build | None (runs in container) |
| `tool` | git operations, file transforms | None |
| `github_api` | create PR, post comment | GitHub installation token |

**Key principle**: Validate credentials only when required by that specific step.

## Two Concerns, Separated

### 1. Identity & Authorization
*Who can run what?*

- User must own the project (enforced via `canAccessProject`)
- User must have appropriate role/permissions
- Project policies may restrict certain operations

### 2. Credential Resolution
*What secrets does this step need?*

- Determined by `execution_mode` and step configuration
- Resolved at job execution time, not run creation
- Missing credentials fail the specific step, not the entire run

## Credential Requirements by Step

```typescript
interface StepCredentials {
  mode: 'none' | 'ai_provider' | 'github_installation';
  provider?: ApiKeyProvider;  // Required when mode = 'ai_provider'
}

const STEP_CREDENTIALS: Record<RunStep, StepCredentials> = {
  // No credentials needed
  setup_worktree: { mode: 'none' },
  route: { mode: 'none' },
  cleanup: { mode: 'none' },

  // AI provider credentials
  planner_create_plan: { mode: 'ai_provider', provider: 'anthropic' },
  reviewer_review_plan: { mode: 'ai_provider', provider: 'anthropic' },
  implementer_apply_changes: { mode: 'ai_provider', provider: 'anthropic' },
  tester_run_tests: { mode: 'none' },  // Script execution, no AI
  reviewer_review_code: { mode: 'ai_provider', provider: 'anthropic' },

  // GitHub credentials (from installation, not user)
  create_pr: { mode: 'github_installation' },

  // Human gates (no credentials)
  wait_plan_approval: { mode: 'none' },
  wait_pr_merge: { mode: 'none' },
};
```

## Worker Credential Resolution

```typescript
async function resolveCredentials(
  db: Database,
  step: RunStep,
  context: { userId: string; installationId: number }
): Promise<ResolvedCredentials> {
  const requirements = STEP_CREDENTIALS[step];

  switch (requirements.mode) {
    case 'none':
      return { type: 'none' };

    case 'ai_provider':
      const apiKey = getUserApiKey(db, context.userId, requirements.provider!);
      if (apiKey === null) {
        throw new MissingCredentialError(
          `${requirements.provider} API key required for ${step}`
        );
      }
      return { type: 'ai_provider', provider: requirements.provider!, apiKey };

    case 'github_installation':
      const octokit = await getInstallationOctokit(context.installationId);
      return { type: 'github', octokit };
  }
}
```

## Per-User AI Provider Keys

For steps with `mode: 'ai_provider'`, keys are stored per-user:

### Supported Providers

| Provider | Key Prefix | Models |
|----------|------------|--------|
| `anthropic` | `sk-ant-` | Claude 3.5 Sonnet, Claude 3 Opus |
| `openai` | `sk-` | GPT-4, GPT-4 Turbo |
| `google` | `AIza` | Gemini Pro, Gemini Ultra |
| `mistral` | (none) | Mistral Large, Mixtral |

### Database Schema

```sql
CREATE TABLE user_api_keys (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  api_key TEXT NOT NULL,         -- encrypted
  api_key_nonce TEXT,            -- AES-GCM nonce
  key_encrypted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
)
```

### Shared Module API

```typescript
// Check if user has a provider configured
hasUserApiKey(db, userId, provider): boolean

// Get decrypted key (returns null if not configured)
getUserApiKey(db, userId, provider): string | null

// Set/update a key (encrypts automatically)
setUserApiKey(db, userId, provider, apiKey): UserApiKey

// Delete a key
deleteUserApiKey(db, userId, provider): boolean

// List all keys for user (masked, shows last 4 chars only)
listUserApiKeys(db, userId): UserApiKey[]
```

## GitHub Installation Credentials

For steps with `mode: 'github_installation'`:

- Credentials come from the GitHub App installation, not the user
- Installation ID stored on the project
- Token obtained via `getInstallationOctokit(installationId)`
- Scoped to repositories the installation has access to

## Validation Strategy

### At Run Creation
Only validate that the user can create runs (authorization), not credentials:
```typescript
function canCreateRun(user: AuthUser, project: Project): boolean {
  return canAccessProject(user, project);
}
```

### At Step Execution
Validate credentials when the step actually runs:
```typescript
async function executeStep(job: StepJob): Promise<void> {
  const credentials = await resolveCredentials(db, job.step, job.context);
  // If credentials missing, MissingCredentialError thrown
  // Step fails, run can continue to other steps or halt based on config
}
```

### Benefits
- Runs can start even if some provider keys aren't configured
- Script-only runs (lint, test) work without any AI keys
- Clear error messages at the point of failure
- Users can configure keys after run creation but before AI steps execute

## Security

1. **Encryption at rest**: AI keys use AES-256-GCM
2. **No logging**: Credentials never appear in logs
3. **Isolation**: Users can only access their own AI keys
4. **Scoped access**: GitHub tokens scoped to installation permissions
5. **Per-invocation**: AI clients created fresh each time (keys may change)

## Implementation Status

- [x] Migration 011: `user_api_keys` table
- [x] Shared module: AI key CRUD operations
- [ ] Step credential requirements mapping
- [ ] Credential resolution in worker
- [ ] API routes: `/api/user/api-keys`
- [ ] Settings UI: Key management

## Environment Variables

Development overrides (optional):
```bash
ANTHROPIC_API_KEY_OVERRIDE=sk-ant-...
OPENAI_API_KEY_OVERRIDE=sk-...
```

Production requires:
```bash
DATABASE_ENCRYPTION_KEY=<64-char hex>  # For AI key encryption
```
