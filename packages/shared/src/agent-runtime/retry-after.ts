/**
 * Retry-After Header Extraction
 *
 * Parses the `retry-after` header from API error responses.
 * Shared by both the Anthropic provider and the Agent SDK backend.
 */

/**
 * Extract the Retry-After header value from an error object and convert
 * it to milliseconds.
 *
 * Handles both `Headers`-like APIs (with `.get()`) and plain
 * `Record<string, unknown>` objects (case-insensitive key lookup).
 *
 * Returns `undefined` when the header is missing, non-numeric, or
 * outside the valid range (0 < seconds < 3600).
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object' || !('headers' in err)) return undefined;
  const headers = (err as { headers: unknown }).headers;
  let value: string | null = null;

  // Handle Headers-like API (has .get())
  if (
    headers !== null &&
    typeof headers === 'object' &&
    'get' in headers &&
    typeof (headers as { get: unknown }).get === 'function'
  ) {
    value = (headers as { get: (k: string) => string | null }).get('retry-after');
  }
  // Handle plain Record<string, unknown> — case-insensitive + string-only
  else if (headers !== null && typeof headers === 'object') {
    const headerObj = headers as Record<string, unknown>;
    const key = Object.keys(headerObj).find(k => k.toLowerCase() === 'retry-after');
    const rawValue = key !== undefined ? headerObj[key] : undefined;
    value = typeof rawValue === 'string' ? rawValue : null;
  }

  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0 && seconds < 3600) {
    return Math.ceil(seconds * 1000);
  }
  return undefined;
}
