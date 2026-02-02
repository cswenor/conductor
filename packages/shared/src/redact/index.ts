/**
 * Central Redaction Utility
 *
 * Applies at all system boundaries to prevent secrets from being
 * stored in the database, mirrored to GitHub, or logged.
 *
 * Key principle: "We'll redact later" → permanent toxicity
 */

import { createHash } from 'crypto';

/**
 * Result of redaction operation
 */
export interface RedactResult {
  /** Redacted JSON string */
  json: string;
  /** List of field paths that were removed */
  fieldsRemoved: string[];
  /** Whether any secrets were detected */
  secretsDetected: boolean;
  /** SHA256 hash of the canonical JSON (for integrity verification) */
  payloadHash: string;
  /** Hash scheme identifier */
  payloadHashScheme: 'sha256:cjson:v1';
}

/**
 * Options for redaction
 */
export interface RedactOptions {
  /** Fields to always allow (won't be redacted even if they match patterns) */
  allowlist?: string[];
  /** Additional fields to redact beyond defaults */
  additionalSensitiveFields?: string[];
  /** Whether to redact values that match secret patterns */
  detectSecrets?: boolean;
  /** Maximum depth to traverse (default: 10) */
  maxDepth?: number;
}

/**
 * Default sensitive field names (case-insensitive)
 */
const DEFAULT_SENSITIVE_FIELDS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'accesstoken',
  'access-token',
  'refresh_token',
  'refreshtoken',
  'refresh-token',
  'private_key',
  'privatekey',
  'private-key',
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'connection_string',
  'connectionstring',
  'connection-string',
  'database_url',
  'databaseurl',
  'database-url',
  'db_password',
  'dbpassword',
  'db-password',
  'ssh_key',
  'sshkey',
  'ssh-key',
  'signing_key',
  'signingkey',
  'signing-key',
  'encryption_key',
  'encryptionkey',
  'encryption-key',
  'webhook_secret',
  'webhooksecret',
  'webhook-secret',
  'client_secret',
  'clientsecret',
  'client-secret',
]);

/**
 * Secret patterns to detect in values
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // GitHub tokens
  { name: 'github_pat', pattern: /ghp_[a-zA-Z0-9]{36,}/ },
  { name: 'github_oauth', pattern: /gho_[a-zA-Z0-9]{36,}/ },
  { name: 'github_app', pattern: /ghu_[a-zA-Z0-9]{36,}/ },
  { name: 'github_refresh', pattern: /ghr_[a-zA-Z0-9]{36,}/ },
  { name: 'github_fine_grained', pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/ },

  // AWS credentials
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws_secret_key', pattern: /[a-zA-Z0-9/+=]{40}/ },

  // Generic API keys
  { name: 'api_key_generic', pattern: /[a-zA-Z0-9_-]*api[_-]?key[a-zA-Z0-9_-]*[:=]["']?[a-zA-Z0-9_-]{20,}["']?/i },

  // Bearer tokens
  { name: 'bearer_token', pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/i },

  // JWT tokens
  { name: 'jwt', pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/ },

  // Private keys
  { name: 'rsa_private_key', pattern: /-----BEGIN RSA PRIVATE KEY-----/ },
  { name: 'openssh_private_key', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { name: 'private_key_generic', pattern: /-----BEGIN PRIVATE KEY-----/ },
  { name: 'ec_private_key', pattern: /-----BEGIN EC PRIVATE KEY-----/ },

  // Database connection strings
  { name: 'postgres_url', pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@/ },
  { name: 'mysql_url', pattern: /mysql:\/\/[^:]+:[^@]+@/ },
  { name: 'mongodb_url', pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/ },
  { name: 'redis_url', pattern: /redis:\/\/[^:]+:[^@]+@/ },

  // Slack tokens
  { name: 'slack_token', pattern: /xox[baprs]-[0-9]+-[0-9]+-[a-zA-Z0-9]+/ },

  // Stripe keys
  { name: 'stripe_key', pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
  { name: 'stripe_test_key', pattern: /sk_test_[a-zA-Z0-9]{24,}/ },

  // Twilio
  { name: 'twilio_key', pattern: /SK[a-f0-9]{32}/ },

  // SendGrid
  { name: 'sendgrid_key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/ },

  // npm tokens
  { name: 'npm_token', pattern: /npm_[a-zA-Z0-9]{36}/ },

  // Anthropic API keys
  { name: 'anthropic_key', pattern: /sk-ant-[a-zA-Z0-9_-]{40,}/ },

  // OpenAI API keys
  { name: 'openai_key', pattern: /sk-[a-zA-Z0-9]{48}/ },
];

/**
 * Placeholder for redacted values
 */
const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Check if a field name is sensitive
 */
function isSensitiveField(fieldName: string, additionalFields: Set<string>): boolean {
  const lower = fieldName.toLowerCase();
  return DEFAULT_SENSITIVE_FIELDS.has(lower) || additionalFields.has(lower);
}

/**
 * Check if a value contains a secret pattern
 */
function detectSecretInValue(value: string): { detected: boolean; patterns: string[] } {
  const matchedPatterns: string[] = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      matchedPatterns.push(name);
    }
  }

  return {
    detected: matchedPatterns.length > 0,
    patterns: matchedPatterns,
  };
}

/**
 * Compute canonical JSON hash
 */
function computeHash(obj: unknown): string {
  // Sort keys recursively for canonical representation
  const canonical = JSON.stringify(obj, (_, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce(
          (sorted, key) => {
            sorted[key] = record[key];
            return sorted;
          },
          {} as Record<string, unknown>
        );
    }
    return value;
  });

  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Recursively redact an object
 */
function redactObject(
  obj: unknown,
  path: string,
  options: {
    allowlist: Set<string>;
    additionalSensitiveFields: Set<string>;
    detectSecrets: boolean;
    maxDepth: number;
  },
  depth: number,
  result: { fieldsRemoved: string[]; secretsDetected: boolean }
): unknown {
  // Depth limit
  if (depth > options.maxDepth) {
    return REDACTED_PLACEHOLDER;
  }

  // Null or undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Primitive types
  if (typeof obj === 'string') {
    // Check for secrets in string values
    if (options.detectSecrets) {
      const secretCheck = detectSecretInValue(obj);
      if (secretCheck.detected) {
        result.secretsDetected = true;
        result.fieldsRemoved.push(`${path} (secret: ${secretCheck.patterns.join(', ')})`);
        return REDACTED_PLACEHOLDER;
      }
    }
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // Array
  if (Array.isArray(obj)) {
    return obj.map((item, index) =>
      redactObject(
        item,
        `${path}[${index}]`,
        options,
        depth + 1,
        result
      )
    );
  }

  // Object
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = path !== '' ? `${path}.${key}` : key;

    // Check allowlist first
    if (options.allowlist.has(key.toLowerCase())) {
      redacted[key] = redactObject(value, fieldPath, options, depth + 1, result);
      continue;
    }

    // Check if field name is sensitive
    if (isSensitiveField(key, options.additionalSensitiveFields)) {
      result.fieldsRemoved.push(fieldPath);
      redacted[key] = REDACTED_PLACEHOLDER;
      continue;
    }

    // Recursively process
    redacted[key] = redactObject(value, fieldPath, options, depth + 1, result);
  }

  return redacted;
}

/**
 * Redact sensitive information from an object
 *
 * @param input - The object to redact
 * @param options - Redaction options
 * @returns RedactResult with redacted JSON, removed fields, and hash
 *
 * @example
 * const result = redact({
 *   user: 'john',
 *   password: 'secret123',
 *   config: { api_key: 'sk-abc123' }
 * });
 * // result.json = '{"user":"john","password":"[REDACTED]","config":{"api_key":"[REDACTED]"}}'
 * // result.fieldsRemoved = ['password', 'config.api_key']
 */
export function redact(input: unknown, options: RedactOptions = {}): RedactResult {
  const {
    allowlist = [],
    additionalSensitiveFields = [],
    detectSecrets = true,
    maxDepth = 10,
  } = options;

  const allowlistSet = new Set(allowlist.map((f) => f.toLowerCase()));
  const additionalFieldsSet = new Set(additionalSensitiveFields.map((f) => f.toLowerCase()));

  const result = {
    fieldsRemoved: [] as string[],
    secretsDetected: false,
  };

  const redacted = redactObject(
    input,
    '',
    {
      allowlist: allowlistSet,
      additionalSensitiveFields: additionalFieldsSet,
      detectSecrets,
      maxDepth,
    },
    0,
    result
  );

  const json = JSON.stringify(redacted);
  const payloadHash = computeHash(redacted);

  return {
    json,
    fieldsRemoved: result.fieldsRemoved,
    secretsDetected: result.secretsDetected,
    payloadHash,
    payloadHashScheme: 'sha256:cjson:v1',
  };
}

/**
 * Check if a string contains any secret patterns
 *
 * Useful for quick validation before logging or storing.
 */
export function containsSecrets(value: string): boolean {
  return detectSecretInValue(value).detected;
}

/**
 * Get list of detected secret patterns in a string
 */
export function detectSecrets(value: string): string[] {
  return detectSecretInValue(value).patterns;
}

/**
 * Redact a string value directly (for simple cases)
 */
export function redactString(value: string): string {
  if (containsSecrets(value)) {
    return REDACTED_PLACEHOLDER;
  }
  return value;
}
