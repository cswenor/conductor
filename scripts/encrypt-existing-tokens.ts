#!/usr/bin/env npx tsx
/**
 * Encrypt Existing Tokens Script
 *
 * One-time migration script to encrypt existing plaintext OAuth tokens.
 * Run this after setting DATABASE_ENCRYPTION_KEY for existing databases.
 *
 * Usage:
 *   DATABASE_ENCRYPTION_KEY=<key> DATABASE_PATH=./conductor.db npx tsx scripts/encrypt-existing-tokens.ts
 *
 * Options:
 *   --dry-run    Show what would be encrypted without making changes
 */

import Database from 'better-sqlite3';
import { initEncryption, encrypt, isEncryptionInitialized } from '../packages/shared/src/crypto/index';

interface UserRow {
  user_id: string;
  github_access_token: string | null;
  github_refresh_token: string | null;
  tokens_encrypted: number;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const encryptionKey = process.env['DATABASE_ENCRYPTION_KEY'];
  const databasePath = process.env['DATABASE_PATH'] ?? './conductor.db';

  if (encryptionKey === undefined || encryptionKey === '') {
    console.error('Error: DATABASE_ENCRYPTION_KEY environment variable is required');
    process.exit(1);
  }

  // Initialize encryption
  try {
    initEncryption(encryptionKey);
    console.log('Encryption initialized');
  } catch (err) {
    console.error('Failed to initialize encryption:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (!isEncryptionInitialized()) {
    console.error('Encryption failed to initialize');
    process.exit(1);
  }

  // Open database
  console.log(`Opening database: ${databasePath}`);
  const db = new Database(databasePath);

  try {
    // Check if tokens_encrypted column exists
    const tableInfo = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const hasEncryptionColumns = tableInfo.some(col => col.name === 'tokens_encrypted');

    if (!hasEncryptionColumns) {
      console.error(
        'Error: Database schema is missing encryption columns. ' +
        'Run migrations first to add the required columns.'
      );
      process.exit(1);
    }

    // Find users with plaintext tokens
    const stmt = db.prepare(`
      SELECT user_id, github_access_token, github_refresh_token, tokens_encrypted
      FROM users
      WHERE tokens_encrypted = 0
        AND (github_access_token IS NOT NULL OR github_refresh_token IS NOT NULL)
    `);
    const users = stmt.all() as UserRow[];

    if (users.length === 0) {
      console.log('No users with plaintext tokens found. Nothing to do.');
      return;
    }

    console.log(`Found ${users.length} user(s) with plaintext tokens`);

    if (dryRun) {
      console.log('\n[DRY RUN] Would encrypt tokens for:');
      for (const user of users) {
        console.log(`  - ${user.user_id}: access=${user.github_access_token !== null}, refresh=${user.github_refresh_token !== null}`);
      }
      console.log('\nRun without --dry-run to perform encryption.');
      return;
    }

    // Prepare update statement
    const updateStmt = db.prepare(`
      UPDATE users
      SET
        github_access_token = ?,
        github_access_token_nonce = ?,
        github_refresh_token = ?,
        github_refresh_token_nonce = ?,
        tokens_encrypted = 1
      WHERE user_id = ?
    `);

    // Encrypt tokens in a transaction
    const encryptTokens = db.transaction(() => {
      let encrypted = 0;

      for (const user of users) {
        let accessToken: string | null = null;
        let accessTokenNonce: string | null = null;
        let refreshToken: string | null = null;
        let refreshTokenNonce: string | null = null;

        if (user.github_access_token !== null) {
          const result = encrypt(user.github_access_token);
          accessToken = result.ciphertext;
          accessTokenNonce = result.nonce;
        }

        if (user.github_refresh_token !== null) {
          const result = encrypt(user.github_refresh_token);
          refreshToken = result.ciphertext;
          refreshTokenNonce = result.nonce;
        }

        updateStmt.run(
          accessToken,
          accessTokenNonce,
          refreshToken,
          refreshTokenNonce,
          user.user_id
        );

        encrypted++;
        console.log(`  Encrypted tokens for user: ${user.user_id}`);
      }

      return encrypted;
    });

    const count = encryptTokens();
    console.log(`\nSuccessfully encrypted tokens for ${count} user(s)`);

  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
