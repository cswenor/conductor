/**
 * Secret Redaction Utility
 *
 * Shared utility for redacting common secret patterns from text content.
 * Used by both agent-runtime context assembly and rewind context summaries.
 */

import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:redact' });

export const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Anthropic API keys
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: 'anthropic_key' },
  // OpenAI API keys
  { pattern: /sk-[A-Za-z0-9]{20,}/g, label: 'openai_key' },
  // Google AI keys
  { pattern: /AIza[A-Za-z0-9_-]{30,}/g, label: 'google_key' },
  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{30,}/g, label: 'github_pat' },
  { pattern: /ghs_[A-Za-z0-9]{30,}/g, label: 'github_server' },
  { pattern: /github_pat_[A-Za-z0-9_]{30,}/g, label: 'github_fine_pat' },
  // Slack tokens
  { pattern: /xoxb-[A-Za-z0-9-]{30,}/g, label: 'slack_bot' },
  { pattern: /xoxp-[A-Za-z0-9-]{30,}/g, label: 'slack_user' },
  // AWS access keys
  { pattern: /AKIA[A-Z0-9]{16}/g, label: 'aws_key' },
  // Config-line secrets (password=..., secret=..., token=...)
  { pattern: /(?:password|secret|token|api_key|apikey)\s*[=:]\s*['"]?(?!\[REDACTED)[^\s'"]{8,}['"]?/gi, label: 'config_secret' },
  // Long base64 blocks (> 40 chars, likely secrets)
  { pattern: /[A-Za-z0-9+/]{40,}={0,2}(?=\s|$)/g, label: 'base64_blob' },
];

/**
 * Redact common secret patterns from content.
 * Returns the redacted content. Logs a warning when redaction triggers.
 */
export function redactSecretPatterns(content: string, filePath?: string): string {
  let redacted = content;
  let redactionCount = 0;

  for (const { pattern, label } of SECRET_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    const matches = redacted.match(pattern);
    if (matches !== null) {
      redactionCount += matches.length;
      redacted = redacted.replace(pattern, `[REDACTED:${label}]`);
    }
  }

  if (redactionCount > 0) {
    log.warn(
      { filePath, redactionCount },
      'Secret patterns redacted from content before prompt assembly'
    );
  }

  return redacted;
}
