/**
 * Regression guard: ensures every file that calls transitionPhase() or
 * evaluateGatesAndTransition() has a matching publishTransitionEvent() call,
 * and that the per-file count of transition call sites matches a maintained
 * allowlist.
 *
 * If this test fails, it means a transition site was added or removed.
 * Add publishTransitionEvent() at the new site and update the allowlist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Monorepo root (this file lives in packages/shared/src/pubsub/)
const ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Expected number of transitionPhase( / evaluateGatesAndTransition( call
 * sites per production file. Total: 27.
 */
const EXPECTED_COUNTS: Record<string, number> = {
  'packages/worker/src/index.ts': 10,
  'packages/worker/src/merge-handler.ts': 3,
  'packages/worker/src/blocked-retry.ts': 2,
  'packages/web/src/lib/actions/run-actions.ts': 6,
  'packages/web/src/app/api/runs/[id]/actions/route.ts': 6,
};

/** Files with transition-related references that are NOT call sites. */
const EXCLUDED_PATTERNS = [
  'orchestrator/index.ts',   // function definition
  'mirroring/mirror.ts',     // JSDoc comment only
];

// Match actual call sites: transitionPhase(db, ...) or evaluateGatesAndTransition(\n
// The [^)] excludes prose like transitionPhase() in comments/JSDoc.
const TRANSITION_PATTERN = /(?:transitionPhase|evaluateGatesAndTransition)\([^)]/g;

function countMatches(filePath: string): number {
  const content = readFileSync(resolve(ROOT, filePath), 'utf-8');
  const matches = content.match(TRANSITION_PATTERN);
  return matches?.length ?? 0;
}

/** Recursively find all .ts files (not .d.ts) under a directory. */
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

describe('publish-guard: transition site allowlist', () => {
  for (const [file, expectedCount] of Object.entries(EXPECTED_COUNTS)) {
    it(`${file} has exactly ${expectedCount} transition call sites`, () => {
      const actual = countMatches(file);
      expect(
        actual,
        `Count changed in ${file}: expected ${expectedCount}, found ${actual} — add publishTransitionEvent and update allowlist`,
      ).toBe(expectedCount);
    });
  }

  it('no unlisted production files contain transitionPhase calls', () => {
    const allTsFiles: string[] = [];

    for (const pkg of ['packages/shared/src', 'packages/worker/src', 'packages/web/src']) {
      const files = findTsFiles(resolve(ROOT, pkg));
      for (const f of files) {
        const rel = f.slice(ROOT.length + 1);
        allTsFiles.push(rel);
      }
    }

    const unlisted: string[] = [];

    for (const rel of allTsFiles) {
      // Skip test files
      if (rel.endsWith('.test.ts') || rel.endsWith('.spec.ts')) continue;
      // Skip known excluded patterns
      if (EXCLUDED_PATTERNS.some((p) => rel.includes(p))) continue;
      // Skip files already in the allowlist
      if (EXPECTED_COUNTS[rel] !== undefined) continue;

      const count = countMatches(rel);
      if (count > 0) {
        unlisted.push(`${rel} (${count} calls)`);
      }
    }

    expect(
      unlisted,
      `New file(s) have transitionPhase calls — add publishTransitionEvent and add to allowlist:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});
