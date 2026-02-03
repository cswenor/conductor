/**
 * Migration 006: Users and Sessions
 *
 * Adds user accounts and session management for authentication.
 * Part of WP13-A: Auth Spine.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration006: Migration = {
  version: 6,
  name: 'users_and_sessions',
  up: (db: Database) => {
    // =========================================================================
    // Users
    // =========================================================================

    db.exec(`
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,

        -- GitHub identity (from OAuth)
        github_id INTEGER NOT NULL UNIQUE,
        github_node_id TEXT NOT NULL UNIQUE,
        github_login TEXT NOT NULL,
        github_name TEXT,
        github_email TEXT,
        github_avatar_url TEXT,

        -- OAuth tokens (encrypted in production)
        github_access_token TEXT,
        github_refresh_token TEXT,
        github_token_expires_at TEXT,

        -- Account status
        status TEXT NOT NULL DEFAULT 'active',

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      )
    `);

    // =========================================================================
    // Sessions
    // =========================================================================

    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

        -- Session token (hashed for storage)
        token_hash TEXT NOT NULL UNIQUE,

        -- Session metadata
        user_agent TEXT,
        ip_address TEXT,

        -- Expiration
        expires_at TEXT NOT NULL,

        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Indexes
    // =========================================================================

    db.exec(`CREATE INDEX idx_users_github_id ON users(github_id)`);
    db.exec(`CREATE INDEX idx_users_github_login ON users(github_login)`);
    db.exec(`CREATE INDEX idx_users_status ON users(status)`);

    db.exec(`CREATE INDEX idx_sessions_user ON sessions(user_id)`);
    db.exec(`CREATE INDEX idx_sessions_token ON sessions(token_hash)`);
    db.exec(`CREATE INDEX idx_sessions_expires ON sessions(expires_at)`);
  },
};
