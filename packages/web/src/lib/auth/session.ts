/**
 * Server-side session utilities for Server Components and Server Actions.
 *
 * getServerUser() is the single source of truth for session validation,
 * usable from both Server Components and Server Actions.
 */

import { cookies } from 'next/headers';
import { validateSession } from '@conductor/shared';
import { getDb } from '@/lib/bootstrap';
import { SESSION_COOKIE_NAME, userToAuthUser, type AuthUser } from '@/lib/auth/middleware';

/**
 * Get the authenticated user from the session cookie.
 * Returns null if not authenticated.
 */
export async function getServerUser(): Promise<AuthUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (token === undefined || token === '') return null;
  const db = await getDb();
  const user = validateSession(db, token);
  return user ? userToAuthUser(user) : null;
}

/**
 * Get the authenticated user or throw.
 * Use in Server Actions that require authentication.
 */
export async function requireServerUser(): Promise<AuthUser> {
  const user = await getServerUser();
  if (!user) throw new Error('Authentication required');
  return user;
}
