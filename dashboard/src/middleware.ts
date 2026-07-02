// dashboard/src/middleware.ts
// Next.js Edge Middleware — runs before every page request.
// Redirects unauthenticated users to /login.
// Redirects authenticated users away from /login.
//
// How it works:
//   The API server sets an httpOnly cookie `tmq_token`.
//   The middleware checks if that cookie exists.
//   It does NOT verify the JWT (no crypto in edge runtime needed) —
//   the API server validates it on every data request anyway.
//   Missing cookie = redirect to login. Present cookie = allow through.

import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME  = 'tmq_token';
const PUBLIC_PATHS = ['/login'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic     = PUBLIC_PATHS.some(p => pathname.startsWith(p));
  const hasToken     = req.cookies.has(COOKIE_NAME);

  // Authenticated user visiting login → send to dashboard
  if (isPublic && hasToken) {
    return NextResponse.redirect(new URL('/', req.url));
  }

  // Unauthenticated user visiting protected route → send to login
  if (!isPublic && !hasToken) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('from', pathname); // preserve intended destination
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static files, API routes, and Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
