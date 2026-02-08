/**
 * Artifact Storage Service
 *
 * CRUD operations for the artifacts table.
 * Artifacts are the outputs of agent work — plans, reviews, test reports.
 * Each artifact is versioned, checksummed, and optionally linked to a tool invocation.
 */

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ArtifactType, ValidationStatus } from '../types/index.ts';

// =============================================================================
// Types
// =============================================================================

export interface Artifact {
  artifactId: string;
  runId: string;
  type: ArtifactType;
  version: number;
  contentMarkdown?: string;
  blobRef?: string;
  sizeBytes: number;
  checksumSha256: string;
  validationStatus: ValidationStatus;
  validationErrorsJson?: string;
  validatedAt?: string;
  sourceToolInvocationId?: string;
  githubWriteId?: string;
  createdBy: string;
  createdAt: string;
}

interface ArtifactRow {
  artifact_id: string;
  run_id: string;
  type: string;
  version: number;
  content_markdown: string | null;
  blob_ref: string | null;
  size_bytes: number;
  checksum_sha256: string;
  validation_status: string;
  validation_errors_json: string | null;
  validated_at: string | null;
  source_tool_invocation_id: string | null;
  github_write_id: string | null;
  created_by: string;
  created_at: string;
}

export interface CreateArtifactInput {
  runId: string;
  type: ArtifactType;
  contentMarkdown?: string;
  blobRef?: string;
  sourceToolInvocationId?: string;
  githubWriteId?: string;
  createdBy: string;
}

// =============================================================================
// Helpers
// =============================================================================

export function generateArtifactId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `art_${timestamp}${random}`;
}

function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function mapRow(row: ArtifactRow): Artifact {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    type: row.type as ArtifactType,
    version: row.version,
    contentMarkdown: row.content_markdown ?? undefined,
    blobRef: row.blob_ref ?? undefined,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    validationStatus: row.validation_status as ValidationStatus,
    validationErrorsJson: row.validation_errors_json ?? undefined,
    validatedAt: row.validated_at ?? undefined,
    sourceToolInvocationId: row.source_tool_invocation_id ?? undefined,
    githubWriteId: row.github_write_id ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Create a new artifact.
 * Version is auto-incremented per (runId, type).
 * SHA-256 checksum computed from content.
 */
export function createArtifact(
  db: Database,
  input: CreateArtifactInput
): Artifact {
  const id = generateArtifactId();
  const now = new Date().toISOString();
  const content = input.contentMarkdown ?? input.blobRef ?? '';
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const checksum = computeChecksum(content);

  // Compute next version for (runId, type)
  const versionRow = db.prepare(
    'SELECT MAX(version) as max_version FROM artifacts WHERE run_id = ? AND type = ?'
  ).get(input.runId, input.type) as { max_version: number | null } | undefined;
  const version = (versionRow?.max_version ?? 0) + 1;

  db.prepare(`
    INSERT INTO artifacts (
      artifact_id, run_id, type, version,
      content_markdown, blob_ref, size_bytes, checksum_sha256,
      validation_status,
      source_tool_invocation_id, github_write_id,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id, input.runId, input.type, version,
    input.contentMarkdown ?? null, input.blobRef ?? null,
    sizeBytes, checksum,
    input.sourceToolInvocationId ?? null, input.githubWriteId ?? null,
    input.createdBy, now
  );

  return {
    artifactId: id,
    runId: input.runId,
    type: input.type,
    version,
    contentMarkdown: input.contentMarkdown,
    blobRef: input.blobRef,
    sizeBytes,
    checksumSha256: checksum,
    validationStatus: 'pending',
    sourceToolInvocationId: input.sourceToolInvocationId,
    githubWriteId: input.githubWriteId,
    createdBy: input.createdBy,
    createdAt: now,
  };
}

/**
 * Get an artifact by ID.
 */
export function getArtifact(db: Database, artifactId: string): Artifact | null {
  const row = db.prepare(
    'SELECT * FROM artifacts WHERE artifact_id = ?'
  ).get(artifactId) as ArtifactRow | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRow(row);
}

/**
 * Get the latest (highest version) artifact for a run and type.
 */
export function getLatestArtifact(
  db: Database,
  runId: string,
  type: ArtifactType
): Artifact | null {
  const row = db.prepare(
    'SELECT * FROM artifacts WHERE run_id = ? AND type = ? ORDER BY version DESC LIMIT 1'
  ).get(runId, type) as ArtifactRow | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRow(row);
}

/**
 * Get the latest validated artifact for a run and type.
 * Gates MUST only read artifacts with validation_status = 'valid'.
 * Per ROUTING_AND_GATES.md: "getValidArtifact() returns only artifacts
 * where validation_status = 'valid'."
 */
export function getValidArtifact(
  db: Database,
  runId: string,
  type: ArtifactType
): Artifact | null {
  const row = db.prepare(
    `SELECT * FROM artifacts
     WHERE run_id = ? AND type = ? AND validation_status = 'valid'
     ORDER BY version DESC LIMIT 1`
  ).get(runId, type) as ArtifactRow | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRow(row);
}

/**
 * List artifacts for a run, optionally filtered by type.
 * Ordered by version descending.
 */
export function listArtifacts(
  db: Database,
  runId: string,
  type?: ArtifactType
): Artifact[] {
  if (type !== undefined) {
    const rows = db.prepare(
      'SELECT * FROM artifacts WHERE run_id = ? AND type = ? ORDER BY version DESC'
    ).all(runId, type) as ArtifactRow[];
    return rows.map(mapRow);
  }

  const rows = db.prepare(
    'SELECT * FROM artifacts WHERE run_id = ? ORDER BY type, version DESC'
  ).all(runId) as ArtifactRow[];
  return rows.map(mapRow);
}

/**
 * Update the validation status of an artifact.
 */
export function updateValidationStatus(
  db: Database,
  artifactId: string,
  status: ValidationStatus,
  errors?: string
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE artifacts
    SET validation_status = ?,
        validation_errors_json = ?,
        validated_at = ?
    WHERE artifact_id = ?
  `).run(status, errors ?? null, now, artifactId);
}
