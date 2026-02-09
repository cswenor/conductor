/**
 * Content Redaction for GitHub Mirroring
 *
 * Two-pass approach for redacting secrets from multi-line content
 * before posting to GitHub comments.
 *
 * Pass 1: Full-string scan for multi-line secrets (PEM blocks).
 * Pass 2: Line-by-line scan via redactString() for single-line secrets.
 */

import { redactString } from '../redact/index.ts';

/**
 * Redact sensitive content from a multi-line string.
 *
 * Pass 1: Replace multi-line PEM blocks (BEGIN...END).
 * Pass 2: Line-by-line scan via redactString() for single-line secrets
 *   (tokens, API keys, JWTs, database URLs).
 *
 * Known limitation: redactString() replaces the entire line with [REDACTED]
 * if it contains a secret. This is acceptable for mirroring since the
 * surrounding context of a secret is likely sensitive anyway.
 */
export function redactContent(content: string): string {
  // Pass 1: Replace multi-line PEM blocks
  let result = content.replace(
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    '[REDACTED]',
  );

  // Pass 2: Line-by-line for remaining patterns
  result = result
    .split('\n')
    .map((line) => redactString(line))
    .join('\n');

  return result;
}
