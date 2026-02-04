/**
 * Credential Resolution Service
 *
 * Resolves credentials at step execution time.
 * Given a run and step, produces the concrete credentials
 * needed to invoke the agent or GitHub API.
 */

import type { Database } from 'better-sqlite3';
import type { RunStep } from '../types/index.js';
import type { ApiKeyProvider } from '../api-keys/index.js';
import { getApiKeyForRun } from '../api-keys/index.js';
import { getRun } from '../runs/index.js';
import { getProject } from '../projects/index.js';
import { getInstallationToken } from '../github/index.js';
import { getStepCredentialRequirement } from './credentials.js';

// =============================================================================
// Types
// =============================================================================

export type ResolvedCredentials =
  | { mode: 'none' }
  | { mode: 'ai_provider'; provider: ApiKeyProvider; apiKey: string }
  | { mode: 'github_installation'; installationId: number; token: string };

export interface ResolveCredentialsInput {
  runId: string;
  step: RunStep;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve credentials for a given run and step.
 *
 * Looks up run → project → user, then resolves the credential
 * based on the step's requirement.
 */
export async function resolveCredentials(
  db: Database,
  input: ResolveCredentialsInput
): Promise<ResolvedCredentials> {
  const requirement = getStepCredentialRequirement(input.step);

  if (requirement.mode === 'none') {
    return { mode: 'none' };
  }

  // Look up run and project to get owner info
  const run = getRun(db, input.runId);
  if (run === null) {
    throw new Error(`Run not found: ${input.runId}`);
  }

  const project = getProject(db, run.projectId);
  if (project === null) {
    throw new Error(`Project not found: ${run.projectId}`);
  }

  if (requirement.mode === 'ai_provider') {
    if (requirement.provider === undefined) {
      throw new Error(`No provider specified for step: ${input.step}`);
    }

    if (project.userId === undefined) {
      throw new Error(`Project ${run.projectId} has no owner — cannot resolve API key`);
    }

    const apiKey = getApiKeyForRun(db, project.userId, requirement.provider);
    return { mode: 'ai_provider', provider: requirement.provider, apiKey };
  }

  if (requirement.mode === 'github_installation') {
    const installationId = project.githubInstallationId;
    const token = await getInstallationToken(installationId);
    return { mode: 'github_installation', installationId, token };
  }

  // Exhaustiveness check
  throw new Error(`Unknown credential mode: ${String(requirement.mode)}`);
}
