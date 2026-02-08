/**
 * Migration 009: Token Encryption Nonces
 *
 * Adds columns to store encryption nonces for OAuth tokens.
 * When tokens_encrypted=1, the github_access_token and github_refresh_token
 * columns contain AES-256-GCM encrypted data (hex-encoded).
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration009: Migration = {
  version: 9,
  name: 'token_encryption_nonces',
  up: (db: Database) => {
    // Add nonce columns for token encryption
    db.exec(`
      ALTER TABLE users
      ADD COLUMN github_access_token_nonce TEXT
    `);

    db.exec(`
      ALTER TABLE users
      ADD COLUMN github_refresh_token_nonce TEXT
    `);

    // Flag to track whether tokens are encrypted
    // 0 = plaintext (legacy), 1 = encrypted
    db.exec(`
      ALTER TABLE users
      ADD COLUMN tokens_encrypted INTEGER NOT NULL DEFAULT 0
    `);
  },
};
