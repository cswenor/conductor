/**
 * Rewind Context Summary Builder
 *
 * Builds a deterministic text summary of a run's prior work for injection
 * into the next agent's context after a rewind with preserve mode.
 *
 * Uses existing DB queries (listAgentInvocations, listArtifacts) and
 * applies redactSecretPatterns from the shared utility to artifact content.
 */

import type { Database } from 'better-sqlite3';
import { listAgentInvocations } from '../agent-runtime/invocations.ts';
import { listArtifacts } from '../agent-runtime/artifacts.ts';
import { redactSecretPatterns } from '../utils/redact.ts';

const MAX_INVOCATIONS = 20;
const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_PREVIEW = 500;
const MAX_TOTAL_CHARS = 8000;

/**
 * Build a text summary of a run's prior invocations and artifacts.
 * Called at rewind time when contextMode is 'preserve'.
 *
 * The run should be paused (stable snapshot — no active invocations).
 */
export function buildRewindContextSummary(db: Database, runId: string): string {
  const sections: string[] = [];

  // Section 1: Agent invocation history
  const allInvocations = listAgentInvocations(db, runId);
  // Take the most recent invocations (tail)
  const invocations = allInvocations.slice(-MAX_INVOCATIONS);

  sections.push('### Agent Invocation History');
  if (invocations.length === 0) {
    sections.push('No prior agent invocations.');
  } else {
    if (allInvocations.length > MAX_INVOCATIONS) {
      sections.push(`(showing last ${MAX_INVOCATIONS} of ${allInvocations.length} invocations)`);
    }
    for (const inv of invocations) {
      const duration = inv.durationMs !== undefined ? ` (${inv.durationMs}ms)` : '';
      sections.push(`- ${inv.agent}:${inv.action} — ${inv.status}${duration}`);
    }
  }

  // Section 2: Artifact summaries (latest per type, then cap total)
  const allArtifacts = listArtifacts(db, runId);
  // listArtifacts returns ordered by type, version DESC
  // Group by type and take first (= latest) per type
  const latestByType = new Map<string, typeof allArtifacts[number]>();
  for (const artifact of allArtifacts) {
    if (!latestByType.has(artifact.type)) {
      latestByType.set(artifact.type, artifact);
    }
  }
  const artifacts = [...latestByType.values()].slice(0, MAX_ARTIFACTS);

  sections.push('');
  sections.push('### Artifacts');
  if (artifacts.length === 0) {
    sections.push('No artifacts produced.');
  } else {
    for (const art of artifacts) {
      sections.push(`- **${art.type}** (v${art.version}):`);
      if (art.contentMarkdown !== undefined) {
        let preview = art.contentMarkdown.substring(0, MAX_ARTIFACT_PREVIEW);
        preview = redactSecretPatterns(preview);
        if (art.contentMarkdown.length > MAX_ARTIFACT_PREVIEW) {
          preview += '...';
        }
        sections.push(`  ${preview}`);
      }
    }
  }

  let result = sections.join('\n');

  // Enforce total size limit
  if (result.length > MAX_TOTAL_CHARS) {
    result = result.substring(0, MAX_TOTAL_CHARS - 15) + '\n[...truncated]';
  }

  return result;
}
