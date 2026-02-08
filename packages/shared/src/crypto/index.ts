/**
 * Crypto Module
 *
 * Provides AES-256-GCM encryption for sensitive data at rest.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:crypto' });

// AES-256-GCM constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const NONCE_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

// Module-level encryption key
let encryptionKey: Buffer | null = null;

/**
 * Initialize encryption with a hex-encoded key.
 * Must be called at startup if DATABASE_ENCRYPTION_KEY is set.
 *
 * @param hexKey - 64-character hex string (32 bytes)
 * @throws Error if key is invalid
 */
export function initEncryption(hexKey: string): void {
  if (hexKey.length !== KEY_LENGTH * 2) {
    throw new Error(
      `Invalid encryption key length: expected ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes), got ${hexKey.length}`
    );
  }

  // Validate hex format
  if (!/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error('Invalid encryption key: must be hex-encoded');
  }

  encryptionKey = Buffer.from(hexKey, 'hex');
  log.info('Database encryption initialized');
}

/**
 * Check if encryption is initialized.
 */
export function isEncryptionInitialized(): boolean {
  return encryptionKey !== null;
}

export interface EncryptedData {
  ciphertext: string; // hex-encoded
  nonce: string; // hex-encoded
}

/**
 * Encrypt plaintext using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt
 * @returns Encrypted data with ciphertext and nonce (both hex-encoded)
 * @throws Error if encryption is not initialized
 */
export function encrypt(plaintext: string): EncryptedData {
  if (encryptionKey === null) {
    throw new Error('Encryption not initialized. Call initEncryption() first.');
  }

  // Generate random nonce (IV) for each encryption
  const nonce = randomBytes(NONCE_LENGTH);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, encryptionKey, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  // Encrypt
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // Get auth tag and append to ciphertext
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext: ciphertext.toString('hex'),
    nonce: nonce.toString('hex'),
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 *
 * @param ciphertext - Hex-encoded ciphertext (includes auth tag)
 * @param nonce - Hex-encoded nonce used for encryption
 * @returns Decrypted plaintext
 * @throws Error if encryption is not initialized or decryption fails
 */
export function decrypt(ciphertext: string, nonce: string): string {
  if (encryptionKey === null) {
    throw new Error('Encryption not initialized. Call initEncryption() first.');
  }

  const ciphertextBuffer = Buffer.from(ciphertext, 'hex');
  const nonceBuffer = Buffer.from(nonce, 'hex');

  // Extract auth tag from end of ciphertext
  const authTag = ciphertextBuffer.subarray(ciphertextBuffer.length - AUTH_TAG_LENGTH);
  const encryptedData = ciphertextBuffer.subarray(0, ciphertextBuffer.length - AUTH_TAG_LENGTH);

  // Create decipher
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, nonceBuffer, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  // Set auth tag for verification
  decipher.setAuthTag(authTag);

  // Decrypt
  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Generate a new random encryption key.
 * Useful for initial setup or key rotation.
 *
 * @returns 64-character hex string (32 bytes)
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}
