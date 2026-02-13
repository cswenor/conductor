/**
 * Regression guard for V2 publish helpers.
 *
 * Ensures every file that calls a domain mutation which should emit
 * a V2 stream event has a matching publish*Event call, and that
 * per-file counts match a maintained allowlist.
 *
 * This complements publish-guard.test.ts (which guards transitionPhase → publishTransitionEvent).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../../..');

// =============================================================================
// publishOperatorActionEvent guard
// =============================================================================

/**
 * Expected call site counts for publishOperatorActionEvent per production file.
 * Every recordOperatorAction() call site should have a matching publish.
 */
const OPERATOR_ACTION_COUNTS: Record<string, number> = {
  'packages/web/src/lib/actions/run-actions.ts': 7,
  'packages/web/src/app/api/runs/[id]/actions/route.ts': 7,
};

const OPERATOR_ACTION_PATTERN = /publishOperatorActionEvent\([^)]/g;

// =============================================================================
// publishProjectUpdatedEvent guard
// =============================================================================

const PROJECT_UPDATED_COUNTS: Record<string, number> = {
  'packages/web/src/lib/data/start-work.ts': 1,
};

const PROJECT_UPDATED_PATTERN = /publishProjectUpdatedEvent\([^)]/g;

// =============================================================================
// publishGateEvaluatedEvent guard
// =============================================================================

const GATE_EVALUATED_COUNTS: Record<string, number> = {
  'packages/shared/src/orchestrator/index.ts': 1,
};

const GATE_EVALUATED_PATTERN = /publishGateEvaluatedEvent\([^)]/g;

// =============================================================================
// publishAgentInvocationEvent guard
// =============================================================================

const AGENT_INVOCATION_COUNTS: Record<string, number> = {
  'packages/shared/src/agent-runtime/provider.ts': 6,
  'packages/shared/src/agent-runtime/agents/implementer.ts': 4,
};

const AGENT_INVOCATION_PATTERN = /publishAgentInvocationEvent\([^)]/g;

// =============================================================================
// publishRunUpdatedEvent guard
// =============================================================================

const RUN_UPDATED_COUNTS: Record<string, number> = {
  'packages/worker/src/pr-creation.ts': 3,
  'packages/worker/src/merge-handler.ts': 2,
};

const RUN_UPDATED_PATTERN = /publishRunUpdatedEvent\([^)]/g;

// =============================================================================
// Utility
// =============================================================================

function countMatches(filePath: string, pattern: RegExp): number {
  const content = readFileSync(resolve(ROOT, filePath), 'utf-8');
  const matches = content.match(pattern);
  return matches?.length ?? 0;
}

function findTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      const full = resolve(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

function getAllProductionFiles(): string[] {
  const allTsFiles: string[] = [];
  for (const pkg of ['packages/shared/src', 'packages/worker/src', 'packages/web/src']) {
    const files = findTsFiles(resolve(ROOT, pkg));
    for (const f of files) {
      allTsFiles.push(f.slice(ROOT.length + 1));
    }
  }
  return allTsFiles;
}

// =============================================================================
// Tests
// =============================================================================

describe('publish-guard: publishOperatorActionEvent allowlist', () => {
  for (const [file, expectedCount] of Object.entries(OPERATOR_ACTION_COUNTS)) {
    it(`${file} has exactly ${expectedCount} publishOperatorActionEvent calls`, () => {
      const actual = countMatches(file, OPERATOR_ACTION_PATTERN);
      expect(
        actual,
        `Count changed in ${file}: expected ${expectedCount}, found ${actual} — update allowlist`,
      ).toBe(expectedCount);
    });
  }

  it('no unlisted production files contain publishOperatorActionEvent calls', () => {
    const allFiles = getAllProductionFiles();
    const unlisted: string[] = [];

    for (const rel of allFiles) {
      if (rel.endsWith('.test.ts') || rel.endsWith('.spec.ts')) continue;
      // Skip the definition file
      if (rel.includes('pubsub/index.ts')) continue;
      if (OPERATOR_ACTION_COUNTS[rel] !== undefined) continue;

      const count = countMatches(rel, OPERATOR_ACTION_PATTERN);
      if (count > 0) {
        unlisted.push(`${rel} (${count} calls)`);
      }
    }

    expect(
      unlisted,
      `New file(s) have publishOperatorActionEvent calls — add to allowlist:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});

describe('publish-guard: publishProjectUpdatedEvent allowlist', () => {
  for (const [file, expectedCount] of Object.entries(PROJECT_UPDATED_COUNTS)) {
    it(`${file} has exactly ${expectedCount} publishProjectUpdatedEvent calls`, () => {
      const actual = countMatches(file, PROJECT_UPDATED_PATTERN);
      expect(
        actual,
        `Count changed in ${file}: expected ${expectedCount}, found ${actual} — update allowlist`,
      ).toBe(expectedCount);
    });
  }

  it('no unlisted production files contain publishProjectUpdatedEvent calls', () => {
    const allFiles = getAllProductionFiles();
    const unlisted: string[] = [];

    for (const rel of allFiles) {
      if (rel.endsWith('.test.ts') || rel.endsWith('.spec.ts')) continue;
      if (rel.includes('pubsub/index.ts')) continue;
      if (PROJECT_UPDATED_COUNTS[rel] !== undefined) continue;

      const count = countMatches(rel, PROJECT_UPDATED_PATTERN);
      if (count > 0) {
        unlisted.push(`${rel} (${count} calls)`);
      }
    }

    expect(
      unlisted,
      `New file(s) have publishProjectUpdatedEvent calls — add to allowlist:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});

describe('publish-guard: publishGateEvaluatedEvent allowlist', () => {
  for (const [file, expectedCount] of Object.entries(GATE_EVALUATED_COUNTS)) {
    it(`${file} has exactly ${expectedCount} publishGateEvaluatedEvent calls`, () => {
      const actual = countMatches(file, GATE_EVALUATED_PATTERN);
      expect(
        actual,
        `Count changed in ${file}: expected ${expectedCount}, found ${actual} — update allowlist`,
      ).toBe(expectedCount);
    });
  }

  it('no unlisted production files contain publishGateEvaluatedEvent calls', () => {
    const allFiles = getAllProductionFiles();
    const unlisted: string[] = [];

    for (const rel of allFiles) {
      if (rel.endsWith('.test.ts') || rel.endsWith('.spec.ts')) continue;
      if (rel.includes('pubsub/index.ts')) continue;
      if (GATE_EVALUATED_COUNTS[rel] !== undefined) continue;

      const count = countMatches(rel, GATE_EVALUATED_PATTERN);
      if (count > 0) {
        unlisted.push(`${rel} (${count} calls)`);
      }
    }

    expect(
      unlisted,
      `New file(s) have publishGateEvaluatedEvent calls — add to allowlist:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});

describe('publish-guard: publishAgentInvocationEvent allowlist', () => {
  for (const [file, expectedCount] of Object.entries(AGENT_INVOCATION_COUNTS)) {
    it(`${file} has exactly ${expectedCount} publishAgentInvocationEvent calls`, () => {
      const actual = countMatches(file, AGENT_INVOCATION_PATTERN);
      expect(
        actual,
        `Count changed in ${file}: expected ${expectedCount}, found ${actual} — update allowlist`,
      ).toBe(expectedCount);
    });
  }

  it('no unlisted production files contain publishAgentInvocationEvent calls', () => {
    const allFiles = getAllProductionFiles();
    const unlisted: string[] = [];

    for (const rel of allFiles) {
      if (rel.endsWith('.test.ts') || rel.endsWith('.spec.ts')) continue;
      if (rel.includes('pubsub/index.ts')) continue;
      if (AGENT_INVOCATION_COUNTS[rel] !== undefined) continue;

      const count = countMatches(rel, AGENT_INVOCATION_PATTERN);
      if (count > 0) {
        unlisted.push(`${rel} (${count} calls)`);
      }
    }

    expect(
      unlisted,
      `New file(s) have publishAgentInvocationEvent calls — add to allowlist:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});

describe('publish-guard: publishRunUpdatedEvent allowlist', () => {
  for (const [file, expectedCount] of Object.entries(RUN_UPDATED_COUNTS)) {
    it(`${file} has exactly ${expectedCount} publishRunUpdatedEvent calls`, () => {
      const actual = countMatches(file, RUN_UPDATED_PATTERN);
      expect(
        actual,
        `Count changed in ${file}: expected ${expectedCount}, found ${actual} — update allowlist`,
      ).toBe(expectedCount);
    });
  }

  it('no unlisted production files contain publishRunUpdatedEvent calls', () => {
    const allFiles = getAllProductionFiles();
    const unlisted: string[] = [];

    for (const rel of allFiles) {
      if (rel.endsWith('.test.ts') || rel.endsWith('.spec.ts')) continue;
      if (rel.includes('pubsub/index.ts')) continue;
      if (RUN_UPDATED_COUNTS[rel] !== undefined) continue;

      const count = countMatches(rel, RUN_UPDATED_PATTERN);
      if (count > 0) {
        unlisted.push(`${rel} (${count} calls)`);
      }
    }

    expect(
      unlisted,
      `New file(s) have publishRunUpdatedEvent calls — add to allowlist:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});
