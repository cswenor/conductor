/**
 * Tool Invocations Service
 *
 * CRUD operations for the tool_invocations table.
 * Manages the lifecycle of individual tool calls within an agent invocation.
 */

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

export type ToolInvocationStatus = 'started' | 'completed' | 'failed' | 'blocked';

export interface ToolInvocation {
  toolInvocationId: string;
  agentInvocationId: string;
  runId: string;
  tool: string;
  target?: string;
  argsRedactedJson: string;
  argsFieldsRemovedJson: string;
  argsSecretsDetected: boolean;
  argsPayloadHash: string;
  argsPayloadHashScheme: string;
  resultMetaJson: string;
  resultPayloadHash: string;
  resultPayloadHashScheme: string;
  policyDecision: string;
  policyId?: string;
  policySetId?: string;
  violationId?: string;
  status: ToolInvocationStatus;
  durationMs: number;
  createdAt: string;
}

interface ToolInvocationRow {
  tool_invocation_id: string;
  agent_invocation_id: string;
  run_id: string;
  tool: string;
  target: string | null;
  args_redacted_json: string;
  args_fields_removed_json: string;
  args_secrets_detected: number;
  args_payload_hash: string;
  args_payload_hash_scheme: string;
  result_meta_json: string;
  result_payload_hash: string;
  result_payload_hash_scheme: string;
  policy_decision: string;
  policy_id: string | null;
  policy_set_id: string | null;
  violation_id: string | null;
  status: string;
  duration_ms: number;
  created_at: string;
}

export interface CreateToolInvocationInput {
  agentInvocationId: string;
  runId: string;
  tool: string;
  target?: string;
  argsRedactedJson: string;
  argsFieldsRemovedJson: string;
  argsSecretsDetected: boolean;
  argsPayloadHash: string;
  argsPayloadHashScheme: string;
  policyDecision: string;
  policyId?: string;
  violationId?: string;
}

// =============================================================================
// Helpers
// =============================================================================

export function generateToolInvocationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ti_${timestamp}${random}`;
}

function mapRow(row: ToolInvocationRow): ToolInvocation {
  return {
    toolInvocationId: row.tool_invocation_id,
    agentInvocationId: row.agent_invocation_id,
    runId: row.run_id,
    tool: row.tool,
    target: row.target ?? undefined,
    argsRedactedJson: row.args_redacted_json,
    argsFieldsRemovedJson: row.args_fields_removed_json,
    argsSecretsDetected: row.args_secrets_detected === 1,
    argsPayloadHash: row.args_payload_hash,
    argsPayloadHashScheme: row.args_payload_hash_scheme,
    resultMetaJson: row.result_meta_json,
    resultPayloadHash: row.result_payload_hash,
    resultPayloadHashScheme: row.result_payload_hash_scheme,
    policyDecision: row.policy_decision,
    policyId: row.policy_id ?? undefined,
    policySetId: row.policy_set_id ?? undefined,
    violationId: row.violation_id ?? undefined,
    status: row.status as ToolInvocationStatus,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

// =============================================================================
// CRUD
// =============================================================================

export function createToolInvocation(
  db: Database,
  input: CreateToolInvocationInput
): ToolInvocation {
  const id = generateToolInvocationId();
  const now = new Date().toISOString();

  // For blocked status, use the policyDecision; otherwise start as 'started'
  const status = input.policyDecision === 'block' ? 'blocked' : 'started';

  db.prepare(`
    INSERT INTO tool_invocations (
      tool_invocation_id, agent_invocation_id, run_id, tool, target,
      args_redacted_json, args_fields_removed_json, args_secrets_detected,
      args_payload_hash, args_payload_hash_scheme,
      result_meta_json, result_payload_hash, result_payload_hash_scheme,
      policy_decision, policy_id, policy_set_id, violation_id,
      status, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.agentInvocationId,
    input.runId,
    input.tool,
    input.target ?? null,
    input.argsRedactedJson,
    input.argsFieldsRemovedJson,
    input.argsSecretsDetected ? 1 : 0,
    input.argsPayloadHash,
    input.argsPayloadHashScheme,
    '{}',  // result_meta_json starts empty
    '',    // result_payload_hash starts empty
    'sha256:cjson:v1',
    input.policyDecision,
    input.policyId ?? null,
    null,  // policy_set_id
    input.violationId ?? null,
    status,
    0,
    now
  );

  return {
    toolInvocationId: id,
    agentInvocationId: input.agentInvocationId,
    runId: input.runId,
    tool: input.tool,
    target: input.target,
    argsRedactedJson: input.argsRedactedJson,
    argsFieldsRemovedJson: input.argsFieldsRemovedJson,
    argsSecretsDetected: input.argsSecretsDetected,
    argsPayloadHash: input.argsPayloadHash,
    argsPayloadHashScheme: input.argsPayloadHashScheme,
    resultMetaJson: '{}',
    resultPayloadHash: '',
    resultPayloadHashScheme: 'sha256:cjson:v1',
    policyDecision: input.policyDecision,
    policyId: input.policyId,
    violationId: input.violationId,
    status,
    durationMs: 0,
    createdAt: now,
  };
}

export function completeToolInvocation(
  db: Database,
  id: string,
  input: { resultMeta: Record<string, unknown>; durationMs: number }
): void {
  const resultMetaJson = JSON.stringify(input.resultMeta);
  const resultPayloadHash = createHash('sha256').update(resultMetaJson).digest('hex');

  db.prepare(`
    UPDATE tool_invocations
    SET status = 'completed',
        result_meta_json = ?,
        result_payload_hash = ?,
        duration_ms = ?
    WHERE tool_invocation_id = ?
      AND status = 'started'
  `).run(resultMetaJson, resultPayloadHash, input.durationMs, id);
}

export function failToolInvocation(
  db: Database,
  id: string,
  input: { resultMeta: Record<string, unknown>; durationMs: number }
): void {
  const resultMetaJson = JSON.stringify(input.resultMeta);
  const resultPayloadHash = createHash('sha256').update(resultMetaJson).digest('hex');

  db.prepare(`
    UPDATE tool_invocations
    SET status = 'failed',
        result_meta_json = ?,
        result_payload_hash = ?,
        duration_ms = ?
    WHERE tool_invocation_id = ?
      AND status = 'started'
  `).run(resultMetaJson, resultPayloadHash, input.durationMs, id);
}

export function blockToolInvocation(
  db: Database,
  id: string,
  input: { resultMeta: Record<string, unknown>; durationMs: number; violationId?: string }
): void {
  const resultMetaJson = JSON.stringify(input.resultMeta);
  const resultPayloadHash = createHash('sha256').update(resultMetaJson).digest('hex');

  db.prepare(`
    UPDATE tool_invocations
    SET status = 'blocked',
        result_meta_json = ?,
        result_payload_hash = ?,
        duration_ms = ?,
        violation_id = COALESCE(?, violation_id)
    WHERE tool_invocation_id = ?
  `).run(resultMetaJson, resultPayloadHash, input.durationMs, input.violationId ?? null, id);
}

export function getToolInvocation(
  db: Database,
  id: string
): ToolInvocation | null {
  const row = db.prepare(
    'SELECT * FROM tool_invocations WHERE tool_invocation_id = ?'
  ).get(id) as ToolInvocationRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}

export function listToolInvocations(
  db: Database,
  agentInvocationId: string
): ToolInvocation[] {
  const rows = db.prepare(
    'SELECT * FROM tool_invocations WHERE agent_invocation_id = ? ORDER BY created_at ASC'
  ).all(agentInvocationId) as ToolInvocationRow[];

  return rows.map(mapRow);
}

export function listToolInvocationsByRun(
  db: Database,
  runId: string
): ToolInvocation[] {
  const rows = db.prepare(
    'SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY created_at ASC'
  ).all(runId) as ToolInvocationRow[];

  return rows.map(mapRow);
}
