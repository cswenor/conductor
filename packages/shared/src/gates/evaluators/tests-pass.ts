/**
 * Tests Pass Gate Evaluator
 *
 * Evaluates whether the test suite passes after implementation changes.
 * Checks the TEST_REPORT artifact, cross-references with tool invocation
 * exit code for truth guarantee, supports auto-retry and skip_tests override.
 *
 * Per ROUTING_AND_GATES.md: "Tests run in worktree, not in agent's imagination.
 * Output captured verbatim. Exit code checked — agent cannot fake pass."
 */

import type { Database } from 'better-sqlite3';
import type { Run } from '../../runs/index.ts';
import { getValidArtifact } from '../../agent-runtime/artifacts.ts';
import { getToolInvocation } from '../../agent-runtime/tool-invocations.ts';
import { getGateDefinition } from '../gate-definitions.ts';
import type { GateResult } from './index.ts';

// =============================================================================
// Types
// =============================================================================

interface TestTruth {
  agentResult: string;
  actualPassed: boolean;
  exitCode: number;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Cross-reference a TEST_REPORT artifact with its source tool invocation
 * to determine the actual test result.
 *
 * Per ROUTING_AND_GATES.md: "If agent_interpretation.result differs from
 * actual_passed, the gate engine uses actual_passed."
 */
export function getTestExecutionTruth(
  db: Database,
  sourceToolInvocationId: string,
): TestTruth | null {
  const invocation = getToolInvocation(db, sourceToolInvocationId);
  if (invocation === null) return null;

  const resultMeta = JSON.parse(invocation.resultMetaJson || '{}') as Record<string, unknown>;
  const exitCode = (resultMeta['exitCode'] as number) ?? -1;
  const agentResult = (resultMeta['result'] as string) ?? 'unknown';
  const actualPassed = exitCode === 0;

  return {
    agentResult,
    actualPassed,
    exitCode,
  };
}

/**
 * Check for an active skip_tests override for this run.
 */
function checkSkipTestsOverride(
  db: Database,
  runId: string,
): { operator: string } | null {
  const now = new Date().toISOString();

  const row = db.prepare(`
    SELECT operator, expires_at
    FROM overrides
    WHERE run_id = ? AND kind = 'skip_tests'
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(runId, now) as { operator: string; expires_at: string | null } | undefined;

  if (row === undefined) return null;
  return { operator: row.operator };
}

// =============================================================================
// Evaluator
// =============================================================================

/**
 * Evaluate the tests_pass gate for a run.
 *
 * Logic from ROUTING_AND_GATES.md:
 * 1. Check for skip_tests override → passed
 * 2. Get latest validated TEST_REPORT artifact
 * 3. If no report → pending
 * 4. Cross-reference with tool invocation exit code
 * 5. If passed → passed
 * 6. If failed, check retry count against max
 * 7. If retries left → pending (retry)
 * 8. If exhausted → failed with escalate
 */
export function evaluateTestsPass(db: Database, run: Run): GateResult {
  // 1. Check for skip_tests override
  const skipOverride = checkSkipTestsOverride(db, run.runId);
  if (skipOverride !== null) {
    return {
      status: 'passed',
      reason: `Overridden: skip_tests by @${skipOverride.operator}`,
      details: { override: true },
    };
  }

  // 2. Get latest validated TEST_REPORT artifact
  const testReport = getValidArtifact(db, run.runId, 'test_report');
  if (testReport === null) {
    return {
      status: 'pending',
      reason: 'Tests not yet run',
    };
  }

  // 3. Cross-reference with tool invocation for truth guarantee
  // Per ROUTING_AND_GATES.md: "Exit code checked — agent cannot fake pass."
  // If there's no source tool invocation, we cannot verify the claim → fail safe.
  if (testReport.sourceToolInvocationId === undefined) {
    return {
      status: 'pending',
      reason: 'Test report has no source tool invocation — cannot verify results',
    };
  }

  const truth = getTestExecutionTruth(db, testReport.sourceToolInvocationId);
  if (truth === null) {
    return {
      status: 'pending',
      reason: 'Tool invocation not found — cannot verify test results',
    };
  }
  const testPassed = truth.actualPassed;

  // 4. If tests passed → gate passed
  if (testPassed) {
    return {
      status: 'passed',
      reason: 'All tests passed',
    };
  }

  // 5. Check retry count against max from gate definition config
  const gateDef = getGateDefinition(db, 'tests_pass');
  const config = gateDef !== null
    ? JSON.parse(gateDef.defaultConfigJson) as Record<string, unknown>
    : {};
  const maxRetries = (config['max_retries'] as number) ?? 3;

  if (run.testFixAttempts < maxRetries) {
    return {
      status: 'pending',
      reason: `Tests failed — retry ${run.testFixAttempts + 1}/${maxRetries}`,
      details: {
        testFixAttempts: run.testFixAttempts,
        maxRetries,
      },
    };
  }

  // 6. Retries exhausted → failed with escalation
  return {
    status: 'failed',
    reason: `Tests failed after ${maxRetries} attempts`,
    escalate: true,
    details: {
      testFixAttempts: run.testFixAttempts,
      maxRetries,
    },
  };
}
