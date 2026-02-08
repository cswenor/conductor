/**
 * API utilities for Next.js route handlers
 *
 * Provides consistent error handling and response formatting.
 */

import { NextResponse } from 'next/server';

/**
 * Standard API error response shape
 */
export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

/**
 * Standard API success response shape
 */
export interface ApiSuccess<T> {
  data: T;
}

/**
 * Create a success response
 */
export function success<T>(data: T, status = 200): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ data }, { status });
}

/**
 * Create an error response
 */
export function error(
  message: string,
  code: string,
  status = 500,
  details?: unknown
): NextResponse<ApiError> {
  return NextResponse.json(
    {
      error: message,
      code,
      details,
    },
    { status }
  );
}

/**
 * Common error responses
 */
export const errors = {
  badRequest: (message: string, details?: unknown) =>
    error(message, 'BAD_REQUEST', 400, details),

  unauthorized: (message = 'Unauthorized') => error(message, 'UNAUTHORIZED', 401),

  forbidden: (message = 'Forbidden') => error(message, 'FORBIDDEN', 403),

  notFound: (message = 'Not found') => error(message, 'NOT_FOUND', 404),

  methodNotAllowed: (allowed: string[]) =>
    error(`Method not allowed. Allowed: ${allowed.join(', ')}`, 'METHOD_NOT_ALLOWED', 405),

  conflict: (message: string) => error(message, 'CONFLICT', 409),

  unprocessableEntity: (message: string, details?: unknown) =>
    error(message, 'UNPROCESSABLE_ENTITY', 422, details),

  tooManyRequests: (message = 'Too many requests') => error(message, 'TOO_MANY_REQUESTS', 429),

  internal: (message = 'Internal server error') => error(message, 'INTERNAL_ERROR', 500),

  serviceUnavailable: (message = 'Service unavailable') =>
    error(message, 'SERVICE_UNAVAILABLE', 503),
};

/**
 * Wrap an async route handler with error handling
 *
 * @example
 * export const GET = withErrorHandling(async (request) => {
 *   const data = await fetchData();
 *   return success(data);
 * });
 */
export function withErrorHandling<T>(
  handler: (request: Request) => Promise<NextResponse<T>>
): (request: Request) => Promise<NextResponse<T | ApiError>> {
  return async (request: Request) => {
    try {
      return await handler(request);
    } catch (err) {
      // Log error for debugging
       
      console.error('API error:', err);

      // Return generic error to client
      if (err instanceof Error) {
        // In development, include error message
        if (process.env.NODE_ENV === 'development') {
          return errors.internal(err.message);
        }
      }

      return errors.internal();
    }
  };
}

/**
 * Parse JSON body with error handling
 */
export async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
