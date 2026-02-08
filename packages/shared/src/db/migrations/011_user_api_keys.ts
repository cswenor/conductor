/**
 * Migration 011: User API Keys
 *
 * Adds encrypted storage for per-user API keys for multiple AI providers.
 * Each user provides their own API keys for agent invocations.
 *
 * Supported providers: anthropic, openai, google, mistral, etc.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration011: Migration = {
  version: 11,
  name: 'user_api_keys',
  up: (db: Database) => {
    // Create table for user API keys (supports multiple providers)
    db.exec(`
      CREATE TABLE user_api_keys (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        api_key_nonce TEXT,
        key_encrypted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      )
    `);

    // Index for user lookups
    db.exec(`
      CREATE INDEX idx_user_api_keys_user ON user_api_keys(user_id)
    `);
  },
};
