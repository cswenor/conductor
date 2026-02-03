/**
 * Next.js Middleware
 *
 * Handles authentication redirects for protected pages.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = 'conductor_session';

// Pages that don't require authentication
const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/api/webhooks',
  '/_next',
  '/favicon.ico',
  '/sw.js',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(path => pathname.startsWith(path));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  // In development, allow unauthenticated access
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // No session - redirect to login
  if (sessionToken === undefined) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Has session cookie - allow (actual validation happens in API routes)
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
