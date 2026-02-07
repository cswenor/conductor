/**
 * Next.js Middleware — Page-Level Auth Guard
 *
 * Runs in Edge Runtime on every matched request. Redirects to /login
 * if the session cookie is absent. The actual session validation
 * (token hash lookup, expiry check) happens server-side in withAuth().
 *
 * This prevents unauthenticated users from seeing app pages at all.
 */

import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE_NAME = 'conductor_session';

/** Routes that are accessible without authentication. */
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/',
  '/api/github/callback',
  '/api/github/webhooks',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

export function middleware(request: NextRequest): NextResponse | undefined {
  const { pathname } = request.nextUrl;

  // Allow public paths, static assets, and Next.js internals
  if (
    isPublicPath(pathname) ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon')
  ) {
    return undefined;
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);

  if (sessionCookie === undefined || sessionCookie.value === '') {
    const loginUrl = new URL('/login', request.url);
    // Preserve the original destination so login can redirect back
    if (pathname !== '/' && pathname !== '/dashboard') {
      loginUrl.searchParams.set('redirect', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Cookie exists — let the request through. Server-side withAuth()
  // will do full validation and return 401 if the session is invalid,
  // which client components handle by redirecting to /login.
  return undefined;
}

export const config = {
  // Match all routes except static files and Next.js internals
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
