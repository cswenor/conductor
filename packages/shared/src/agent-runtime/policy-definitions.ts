/**
 * Policy Definitions Seeder
 *
 * Seeds the built-in policy definitions into the policy_definitions table.
 * Follows the same idempotent pattern as ensureDefaultPolicySet.
 */

import type { Database } from 'better-sqlite3';

// =============================================================================
// Built-in Policy Definitions
// =============================================================================

export interface BuiltInPolicy {
  policyId: string;
  severity: string;
  description: string;
  checkPoints: string[];
  defaultConfig: Record<string, unknown>;
}

export const BUILT_IN_POLICIES: BuiltInPolicy[] = [
  {
    policyId: 'worktree_boundary',
    severity: 'critical',
    description: 'Blocks file operations that escape the worktree boundary',
    checkPoints: ['tool_pre_execution'],
    defaultConfig: {},
  },
  {
    policyId: 'dotgit_protection',
    severity: 'critical',
    description: 'Blocks access to .git/ directory',
    checkPoints: ['tool_pre_execution'],
    defaultConfig: {},
  },
  {
    policyId: 'sensitive_file_write',
    severity: 'high',
    description: 'Blocks writes to sensitive files (.env, .pem, credentials, etc)',
    checkPoints: ['tool_pre_execution'],
    defaultConfig: {},
  },
  {
    policyId: 'shell_injection',
    severity: 'critical',
    description: 'Blocks shell operators in run_tests command',
    checkPoints: ['tool_pre_execution'],
    defaultConfig: {},
  },
];

// =============================================================================
// Seeder
// =============================================================================

/**
 * Ensures all built-in policy definitions exist in the database.
 * Idempotent — safe to call multiple times.
 */
export function ensureBuiltInPolicyDefinitions(db: Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO policy_definitions (
      policy_id, severity, description, check_points_json, default_config_json
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const policy of BUILT_IN_POLICIES) {
      insert.run(
        policy.policyId,
        policy.severity,
        policy.description,
        JSON.stringify(policy.checkPoints),
        JSON.stringify(policy.defaultConfig),
      );
    }
  });

  tx();
}
