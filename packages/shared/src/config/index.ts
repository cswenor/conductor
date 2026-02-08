/**
 * Configuration validation module
 *
 * Provides runtime validation for environment variables with
 * type safety, format validation, and helpful error messages.
 */

import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:config' });

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

/** Configuration value types */
export type ConfigType = 'string' | 'number' | 'boolean' | 'url' | 'path';

/** Configuration field definition */
export interface ConfigField {
  /** Environment variable name */
  name: string;
  /** Expected value type */
  type: ConfigType;
  /** Whether the field is required */
  required: boolean;
  /** Default value if not provided */
  default?: string;
  /** Custom validation function */
  validate?: (value: string) => ValidationResult;
  /** Description for error messages */
  description?: string;
}

/**
 * Validate a URL format
 */
function validateUrl(value: string): ValidationResult {
  try {
    new URL(value);
    return { valid: true, value };
  } catch {
    return { valid: false, error: `Invalid URL format: ${value}` };
  }
}

/**
 * Validate a Redis URL format
 */
export function validateRedisUrl(value: string): ValidationResult {
  // Allow redis:// and rediss:// protocols
  if (!value.startsWith('redis://') && !value.startsWith('rediss://')) {
    return { valid: false, error: `Redis URL must start with redis:// or rediss://: ${value}` };
  }
  return validateUrl(value);
}

/**
 * Validate a number
 */
export function validateNumber(
  value: string,
  options?: { min?: number; max?: number }
): ValidationResult {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) {
    return { valid: false, error: `Invalid number: ${value}` };
  }
  if (options?.min !== undefined && num < options.min) {
    return { valid: false, error: `Value ${num} is less than minimum ${options.min}` };
  }
  if (options?.max !== undefined && num > options.max) {
    return { valid: false, error: `Value ${num} is greater than maximum ${options.max}` };
  }
  return { valid: true, value };
}

/**
 * Validate a boolean
 */
export function validateBoolean(value: string): ValidationResult {
  const lower = value.toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(lower)) {
    return { valid: false, error: `Invalid boolean: ${value}` };
  }
  return { valid: true, value };
}

/**
 * Validate a file path (basic check)
 */
export function validatePath(value: string): ValidationResult {
  // Basic validation - no empty paths, no null bytes
  if (value.length === 0) {
    return { valid: false, error: 'Path cannot be empty' };
  }
  if (value.includes('\0')) {
    return { valid: false, error: 'Path cannot contain null bytes' };
  }
  return { valid: true, value };
}

/**
 * Get an environment variable with validation
 */
export function getEnv(field: ConfigField): string {
  const value = process.env[field.name];

  // Handle missing value
  if (value === undefined || value === '') {
    if (field.required && field.default === undefined) {
      throw new Error(
        `Missing required environment variable: ${field.name}` +
          (field.description !== undefined ? ` (${field.description})` : '')
      );
    }
    if (field.default !== undefined) {
      log.debug({ name: field.name, default: field.default }, 'Using default config value');
      return field.default;
    }
    return '';
  }

  // Validate by type
  let result: ValidationResult = { valid: true, value };

  switch (field.type) {
    case 'url':
      result = validateUrl(value);
      break;
    case 'number':
      result = validateNumber(value);
      break;
    case 'boolean':
      result = validateBoolean(value);
      break;
    case 'path':
      result = validatePath(value);
      break;
    case 'string':
    default:
      // No additional validation for strings
      break;
  }

  // Apply custom validation if provided
  if (result.valid && field.validate !== undefined) {
    result = field.validate(value);
  }

  if (!result.valid) {
    throw new Error(
      `Invalid value for ${field.name}: ${result.error ?? 'validation failed'}` +
        (field.description !== undefined ? ` (${field.description})` : '')
    );
  }

  return value;
}

/**
 * Get an optional environment variable with type validation
 */
export function getOptionalEnv(
  name: string,
  defaultValue: string,
  type: ConfigType = 'string'
): string {
  return getEnv({
    name,
    type,
    required: false,
    default: defaultValue,
  });
}

/**
 * Get a required environment variable with type validation
 */
export function getRequiredEnv(name: string, type: ConfigType = 'string'): string {
  return getEnv({
    name,
    type,
    required: true,
  });
}

/**
 * Parse boolean from environment variable
 */
export function parseBoolean(value: string): boolean {
  const lower = value.toLowerCase();
  return ['true', '1', 'yes'].includes(lower);
}

/**
 * Parse integer from environment variable
 */
export function parseIntValue(value: string, fallback: number): number {
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? fallback : num;
}

/**
 * Validate all configuration at startup and log warnings
 */
export function validateConfig(fields: ConfigField[]): Map<string, string> {
  const config = new Map<string, string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of fields) {
    try {
      const value = getEnv(field);
      config.set(field.name, value);

      // Warn about empty optional values that might cause issues
      if (value === '' && !field.required) {
        warnings.push(`${field.name} is empty (using default or blank)`);
      }
    } catch (err) {
      if (err instanceof Error) {
        errors.push(err.message);
      }
    }
  }

  // Log warnings
  for (const warning of warnings) {
    log.warn({ warning }, 'Config warning');
  }

  // Throw aggregated errors
  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
