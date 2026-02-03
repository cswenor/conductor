/**
 * API Keys Module
 *
 * Manages per-user API keys for AI providers.
 * Keys are encrypted at rest using AES-256-GCM.
 *
 * Supported providers: anthropic, openai, google, mistral
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';
import { encrypt, decrypt, isEncryptionInitialized } from '../crypto/index';

const log = createLogger({ name: 'conductor:api-keys' });

// =============================================================================
// Types
// =============================================================================

/** Supported AI provider identifiers */
export type ApiKeyProvider = 'anthropic' | 'openai' | 'google' | 'mistral';

/** Provider metadata for display */
export interface ProviderInfo {
  id: ApiKeyProvider;
  name: string;
  keyPrefix: string | null;
  docUrl: string;
}

/** API key record (without exposing the actual key) */
export interface UserApiKey {
  userId: string;
  provider: ApiKeyProvider;
  configured: boolean;
  lastFour: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Internal database row */
interface ApiKeyRow {
  user_id: string;
  provider: string;
  api_key: string;
  api_key_nonce: string | null;
  key_encrypted: number;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Provider Metadata
// =============================================================================

/** All supported providers with metadata */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    keyPrefix: 'sk-ant-',
    docUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    keyPrefix: 'sk-',
    docUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    name: 'Google AI',
    keyPrefix: 'AIza',
    docUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    keyPrefix: null,
    docUrl: 'https://console.mistral.ai/api-keys/',
  },
];

/**
 * Validate that a provider ID is supported
 */
export function isValidProvider(provider: string): provider is ApiKeyProvider {
  return PROVIDERS.some((p) => p.id === provider);
}

/**
 * Get provider info by ID
 */
export function getProviderInfo(provider: ApiKeyProvider): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === provider);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate API key format for a provider.
 * Returns error message if invalid, null if valid.
 */
export function validateApiKeyFormat(provider: ApiKeyProvider, apiKey: string): string | null {
  if (apiKey.length === 0) {
    return 'API key cannot be empty';
  }

  if (apiKey.length < 20) {
    return 'API key is too short';
  }

  if (apiKey.length > 500) {
    return 'API key is too long';
  }

  const info = getProviderInfo(provider);
  if (info?.keyPrefix !== null && info?.keyPrefix !== undefined && !apiKey.startsWith(info.keyPrefix)) {
    return `${info.name} API keys should start with "${info.keyPrefix}"`;
  }

  return null;
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Get last 4 characters of a key for display (masked)
 */
function getLastFour(apiKey: string): string {
  if (apiKey.length < 4) {
    return '****';
  }
  return apiKey.slice(-4);
}

/**
 * List all API keys for a user (without exposing actual keys)
 */
export function listUserApiKeys(db: Database, userId: string): UserApiKey[] {
  const stmt = db.prepare(`
    SELECT user_id, provider, api_key, api_key_nonce, key_encrypted, created_at, updated_at
    FROM user_api_keys
    WHERE user_id = ?
    ORDER BY provider
  `);

  const rows = stmt.all(userId) as ApiKeyRow[];
  const result: UserApiKey[] = [];

  // Start with all providers as unconfigured
  for (const provider of PROVIDERS) {
    const row = rows.find((r) => r.provider === provider.id);
    if (row !== undefined) {
      // Get decrypted key to show last 4 chars
      let apiKey = row.api_key;
      if (row.key_encrypted === 1 && row.api_key_nonce !== null) {
        if (isEncryptionInitialized()) {
          apiKey = decrypt(row.api_key, row.api_key_nonce);
        }
      }

      result.push({
        userId: row.user_id,
        provider: row.provider as ApiKeyProvider,
        configured: true,
        lastFour: getLastFour(apiKey),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } else {
      result.push({
        userId,
        provider: provider.id,
        configured: false,
        lastFour: null,
        createdAt: '',
        updatedAt: '',
      });
    }
  }

  return result;
}

/**
 * Check if a user has a specific provider key configured
 */
export function hasUserApiKey(db: Database, userId: string, provider: ApiKeyProvider): boolean {
  const stmt = db.prepare(
    'SELECT 1 FROM user_api_keys WHERE user_id = ? AND provider = ?'
  );
  const row = stmt.get(userId, provider);
  return row !== undefined;
}

/**
 * Get a decrypted API key for a user and provider.
 * Returns null if not configured.
 */
export function getUserApiKey(
  db: Database,
  userId: string,
  provider: ApiKeyProvider
): string | null {
  const stmt = db.prepare(`
    SELECT api_key, api_key_nonce, key_encrypted
    FROM user_api_keys
    WHERE user_id = ? AND provider = ?
  `);

  const row = stmt.get(userId, provider) as Pick<ApiKeyRow, 'api_key' | 'api_key_nonce' | 'key_encrypted'> | undefined;

  if (row === undefined) {
    return null;
  }

  // Decrypt if encrypted
  if (row.key_encrypted === 1 && row.api_key_nonce !== null) {
    if (!isEncryptionInitialized()) {
      log.error({ userId, provider }, 'Cannot decrypt API key: encryption not initialized');
      throw new Error('API key is encrypted but encryption is not initialized');
    }
    return decrypt(row.api_key, row.api_key_nonce);
  }

  // Return plaintext key
  return row.api_key;
}

/**
 * Set (create or update) an API key for a user and provider.
 * Key will be encrypted if encryption is initialized.
 */
export function setUserApiKey(
  db: Database,
  userId: string,
  provider: ApiKeyProvider,
  apiKey: string
): UserApiKey {
  const now = new Date().toISOString();

  // Validate format
  const formatError = validateApiKeyFormat(provider, apiKey);
  if (formatError !== null) {
    throw new Error(formatError);
  }

  // Encrypt if encryption is available
  let storedKey = apiKey;
  let nonce: string | null = null;
  let encrypted = 0;

  if (isEncryptionInitialized()) {
    const result = encrypt(apiKey);
    storedKey = result.ciphertext;
    nonce = result.nonce;
    encrypted = 1;
  }

  // Upsert (INSERT OR REPLACE)
  const stmt = db.prepare(`
    INSERT INTO user_api_keys (user_id, provider, api_key, api_key_nonce, key_encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider)
    DO UPDATE SET api_key = excluded.api_key, api_key_nonce = excluded.api_key_nonce, key_encrypted = excluded.key_encrypted, updated_at = excluded.updated_at
  `);

  stmt.run(userId, provider, storedKey, nonce, encrypted, now, now);

  log.info({ userId, provider, encrypted: encrypted === 1 }, 'API key set');

  return {
    userId,
    provider,
    configured: true,
    lastFour: getLastFour(apiKey),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Delete an API key for a user and provider.
 * Returns true if a key was deleted, false if none existed.
 */
export function deleteUserApiKey(
  db: Database,
  userId: string,
  provider: ApiKeyProvider
): boolean {
  const stmt = db.prepare('DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?');
  const result = stmt.run(userId, provider);

  if (result.changes > 0) {
    log.info({ userId, provider }, 'API key deleted');
    return true;
  }

  return false;
}

/**
 * Delete all API keys for a user.
 * Returns the number of keys deleted.
 */
export function deleteAllUserApiKeys(db: Database, userId: string): number {
  const stmt = db.prepare('DELETE FROM user_api_keys WHERE user_id = ?');
  const result = stmt.run(userId);

  if (result.changes > 0) {
    log.info({ userId, count: result.changes }, 'All user API keys deleted');
  }

  return result.changes;
}

// =============================================================================
// Runtime Helpers
// =============================================================================

/**
 * Get the API key for a run, looking up the project owner's key for the required provider.
 * Throws if the user doesn't have the required provider key configured.
 */
export function getApiKeyForRun(
  db: Database,
  userId: string,
  provider: ApiKeyProvider
): string {
  const apiKey = getUserApiKey(db, userId, provider);

  if (apiKey === null) {
    const providerInfo = getProviderInfo(provider);
    throw new Error(
      `${providerInfo?.name ?? provider} API key not configured. Please add your API key in Settings.`
    );
  }

  return apiKey;
}
