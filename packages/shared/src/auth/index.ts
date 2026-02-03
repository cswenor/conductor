/**
 * Auth Module
 *
 * Handles user accounts and session management.
 * Part of WP13-A: Auth Spine.
 */

import type { Database } from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import { createLogger } from '../logger/index';
import { encrypt, decrypt, isEncryptionInitialized } from '../crypto/index';

const log = createLogger({ name: 'conductor:auth' });

// =============================================================================
// Types
// =============================================================================

export interface User {
  userId: string;
  githubId: number;
  githubNodeId: string;
  githubLogin: string;
  githubName: string | null;
  githubEmail: string | null;
  githubAvatarUrl: string | null;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface Session {
  sessionId: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface CreateUserInput {
  githubId: number;
  githubNodeId: string;
  githubLogin: string;
  githubName?: string;
  githubEmail?: string;
  githubAvatarUrl?: string;
  githubAccessToken?: string;
  githubRefreshToken?: string;
  githubTokenExpiresAt?: string;
}

export interface UpdateUserInput {
  githubLogin?: string;
  githubName?: string;
  githubEmail?: string;
  githubAvatarUrl?: string;
  githubAccessToken?: string;
  githubRefreshToken?: string;
  githubTokenExpiresAt?: string;
  status?: User['status'];
}

// =============================================================================
// ID Generation
// =============================================================================

function generateUserId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(6).toString('hex');
  return `user_${timestamp}${random}`;
}

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(6).toString('hex');
  return `sess_${timestamp}${random}`;
}

/**
 * Generate a secure session token (returned to client as cookie)
 */
function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Hash a session token for storage (never store plain tokens)
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// =============================================================================
// User Operations
// =============================================================================

/**
 * Create a new user from GitHub OAuth data.
 * If encryption is initialized, tokens will be encrypted at rest.
 */
export function createUser(db: Database, input: CreateUserInput): User {
  const userId = generateUserId();
  const now = new Date().toISOString();

  // Encrypt tokens if encryption is available
  let accessToken: string | null = input.githubAccessToken ?? null;
  let accessTokenNonce: string | null = null;
  let refreshToken: string | null = input.githubRefreshToken ?? null;
  let refreshTokenNonce: string | null = null;
  let tokensEncrypted = 0;

  if (isEncryptionInitialized() && (accessToken !== null || refreshToken !== null)) {
    if (accessToken !== null) {
      const encrypted = encrypt(accessToken);
      accessToken = encrypted.ciphertext;
      accessTokenNonce = encrypted.nonce;
    }
    if (refreshToken !== null) {
      const encrypted = encrypt(refreshToken);
      refreshToken = encrypted.ciphertext;
      refreshTokenNonce = encrypted.nonce;
    }
    tokensEncrypted = 1;
  }

  const stmt = db.prepare(`
    INSERT INTO users (
      user_id,
      github_id,
      github_node_id,
      github_login,
      github_name,
      github_email,
      github_avatar_url,
      github_access_token,
      github_refresh_token,
      github_token_expires_at,
      github_access_token_nonce,
      github_refresh_token_nonce,
      tokens_encrypted,
      status,
      created_at,
      updated_at,
      last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    userId,
    input.githubId,
    input.githubNodeId,
    input.githubLogin,
    input.githubName ?? null,
    input.githubEmail ?? null,
    input.githubAvatarUrl ?? null,
    accessToken,
    refreshToken,
    input.githubTokenExpiresAt ?? null,
    accessTokenNonce,
    refreshTokenNonce,
    tokensEncrypted,
    'active',
    now,
    now,
    now
  );

  log.info({ userId, githubLogin: input.githubLogin, tokensEncrypted: tokensEncrypted === 1 }, 'User created');

  return {
    userId,
    githubId: input.githubId,
    githubNodeId: input.githubNodeId,
    githubLogin: input.githubLogin,
    githubName: input.githubName ?? null,
    githubEmail: input.githubEmail ?? null,
    githubAvatarUrl: input.githubAvatarUrl ?? null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };
}

/**
 * Get a user by ID
 */
export function getUser(db: Database, userId: string): User | null {
  const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
  const row = stmt.get(userId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToUser(row);
}

/**
 * Get a user by GitHub ID
 */
export function getUserByGithubId(db: Database, githubId: number): User | null {
  const stmt = db.prepare('SELECT * FROM users WHERE github_id = ?');
  const row = stmt.get(githubId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToUser(row);
}

/**
 * Update a user.
 * If encryption is initialized, tokens will be encrypted at rest.
 */
export function updateUser(db: Database, userId: string, input: UpdateUserInput): User | null {
  const updates: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [new Date().toISOString()];
  let needsTokenEncryptionUpdate = false;

  if (input.githubLogin !== undefined) {
    updates.push('github_login = ?');
    values.push(input.githubLogin);
  }
  if (input.githubName !== undefined) {
    updates.push('github_name = ?');
    values.push(input.githubName);
  }
  if (input.githubEmail !== undefined) {
    updates.push('github_email = ?');
    values.push(input.githubEmail);
  }
  if (input.githubAvatarUrl !== undefined) {
    updates.push('github_avatar_url = ?');
    values.push(input.githubAvatarUrl);
  }
  if (input.githubAccessToken !== undefined) {
    if (isEncryptionInitialized()) {
      const encrypted = encrypt(input.githubAccessToken);
      updates.push('github_access_token = ?');
      values.push(encrypted.ciphertext);
      updates.push('github_access_token_nonce = ?');
      values.push(encrypted.nonce);
      needsTokenEncryptionUpdate = true;
    } else {
      updates.push('github_access_token = ?');
      values.push(input.githubAccessToken);
    }
  }
  if (input.githubRefreshToken !== undefined) {
    if (isEncryptionInitialized()) {
      const encrypted = encrypt(input.githubRefreshToken);
      updates.push('github_refresh_token = ?');
      values.push(encrypted.ciphertext);
      updates.push('github_refresh_token_nonce = ?');
      values.push(encrypted.nonce);
      needsTokenEncryptionUpdate = true;
    } else {
      updates.push('github_refresh_token = ?');
      values.push(input.githubRefreshToken);
    }
  }
  if (input.githubTokenExpiresAt !== undefined) {
    updates.push('github_token_expires_at = ?');
    values.push(input.githubTokenExpiresAt);
  }
  if (input.status !== undefined) {
    updates.push('status = ?');
    values.push(input.status);
  }

  // Update tokens_encrypted flag if we encrypted any tokens
  if (needsTokenEncryptionUpdate) {
    updates.push('tokens_encrypted = ?');
    values.push(1);
  }

  values.push(userId);

  const stmt = db.prepare(
    `UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`
  );
  const result = stmt.run(...values);

  if (result.changes === 0) {
    return null;
  }

  log.info({ userId }, 'User updated');
  return getUser(db, userId);
}

/**
 * Update user's last login time
 */
export function updateUserLastLogin(db: Database, userId: string): void {
  const stmt = db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?');
  const now = new Date().toISOString();
  stmt.run(now, now, userId);
}

interface UserTokenRow {
  github_access_token: string | null;
  github_refresh_token: string | null;
  github_access_token_nonce: string | null;
  github_refresh_token_nonce: string | null;
  tokens_encrypted: number;
  github_token_expires_at: string | null;
}

/**
 * Get the decrypted GitHub access token for a user.
 * Returns null if user not found or no token stored.
 */
export function getUserAccessToken(db: Database, userId: string): string | null {
  const stmt = db.prepare(`
    SELECT
      github_access_token,
      github_access_token_nonce,
      tokens_encrypted
    FROM users
    WHERE user_id = ?
  `);
  const row = stmt.get(userId) as UserTokenRow | undefined;

  if (row?.github_access_token === undefined || row.github_access_token === null) {
    return null;
  }

  // Decrypt if encrypted
  if (row.tokens_encrypted === 1 && row.github_access_token_nonce !== null) {
    if (!isEncryptionInitialized()) {
      log.error({ userId }, 'Cannot decrypt token: encryption not initialized');
      throw new Error('Token is encrypted but encryption is not initialized');
    }
    return decrypt(row.github_access_token, row.github_access_token_nonce);
  }

  // Return plaintext token
  return row.github_access_token;
}

/**
 * Get the decrypted GitHub refresh token for a user.
 * Returns null if user not found or no token stored.
 */
export function getUserRefreshToken(db: Database, userId: string): string | null {
  const stmt = db.prepare(`
    SELECT
      github_refresh_token,
      github_refresh_token_nonce,
      tokens_encrypted
    FROM users
    WHERE user_id = ?
  `);
  const row = stmt.get(userId) as UserTokenRow | undefined;

  if (row?.github_refresh_token === undefined || row.github_refresh_token === null) {
    return null;
  }

  // Decrypt if encrypted
  if (row.tokens_encrypted === 1 && row.github_refresh_token_nonce !== null) {
    if (!isEncryptionInitialized()) {
      log.error({ userId }, 'Cannot decrypt token: encryption not initialized');
      throw new Error('Token is encrypted but encryption is not initialized');
    }
    return decrypt(row.github_refresh_token, row.github_refresh_token_nonce);
  }

  // Return plaintext token
  return row.github_refresh_token;
}

/**
 * Get token expiration time for a user.
 */
export function getUserTokenExpiresAt(db: Database, userId: string): string | null {
  const stmt = db.prepare('SELECT github_token_expires_at FROM users WHERE user_id = ?');
  const row = stmt.get(userId) as { github_token_expires_at: string | null } | undefined;
  return row?.github_token_expires_at ?? null;
}

// =============================================================================
// Session Operations
// =============================================================================

/** Session duration: 7 days */
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Create a new session for a user.
 * Returns the session ID and the plain token (to be stored in cookie).
 */
export function createSession(
  db: Database,
  userId: string,
  metadata?: { userAgent?: string; ipAddress?: string }
): { sessionId: string; token: string; expiresAt: string } {
  const sessionId = generateSessionId();
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  const stmt = db.prepare(`
    INSERT INTO sessions (
      session_id,
      user_id,
      token_hash,
      user_agent,
      ip_address,
      expires_at,
      created_at,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionId,
    userId,
    tokenHash,
    metadata?.userAgent ?? null,
    metadata?.ipAddress ?? null,
    expiresAt,
    now,
    now
  );

  log.info({ sessionId, userId }, 'Session created');

  return { sessionId, token, expiresAt };
}

/**
 * Validate a session token and return the associated user.
 * Updates last_active_at on successful validation.
 * Returns null if token is invalid or expired.
 */
export function validateSession(db: Database, token: string): User | null {
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();

  // Find session by token hash
  const sessionStmt = db.prepare(`
    SELECT s.*, u.*
    FROM sessions s
    JOIN users u ON s.user_id = u.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
      AND u.status = 'active'
  `);

  const row = sessionStmt.get(tokenHash, now) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  // Update last_active_at
  const updateStmt = db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?');
  updateStmt.run(now, tokenHash);

  return rowToUser(row);
}

/**
 * Delete a session (logout)
 */
export function deleteSession(db: Database, token: string): boolean {
  const tokenHash = hashToken(token);
  const stmt = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const result = stmt.run(tokenHash);

  if (result.changes > 0) {
    log.info('Session deleted');
    return true;
  }

  return false;
}

/**
 * Delete all sessions for a user
 */
export function deleteUserSessions(db: Database, userId: string): number {
  const stmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const result = stmt.run(userId);
  log.info({ userId, count: result.changes }, 'User sessions deleted');
  return result.changes;
}

/**
 * Clean up expired sessions
 */
export function cleanupExpiredSessions(db: Database): number {
  const now = new Date().toISOString();
  const stmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
  const result = stmt.run(now);

  if (result.changes > 0) {
    log.info({ count: result.changes }, 'Expired sessions cleaned up');
  }

  return result.changes;
}

// =============================================================================
// Helpers
// =============================================================================

function rowToUser(row: Record<string, unknown>): User {
  return {
    userId: row['user_id'] as string,
    githubId: row['github_id'] as number,
    githubNodeId: row['github_node_id'] as string,
    githubLogin: row['github_login'] as string,
    githubName: row['github_name'] as string | null,
    githubEmail: row['github_email'] as string | null,
    githubAvatarUrl: row['github_avatar_url'] as string | null,
    status: row['status'] as User['status'],
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    lastLoginAt: row['last_login_at'] as string | null,
  };
}

// =============================================================================
// Re-exports
// =============================================================================

export { canAccessProject, assertProjectAccess, AuthorizationError, type AuthUser } from './policy';

