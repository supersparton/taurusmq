// packages/dashboard-api/AuthMiddleware.js
//
// JWT verification middleware for the dashboard API.
//
// Token delivery: httpOnly cookie named `tmq_token`
//   - httpOnly: JS cannot read it → XSS-safe
//   - SameSite=Lax: works for same-site AND cross-subdomain deployments
//   - Secure flag: auto-enabled when OBS_HTTPS=true or NODE_ENV=production
//
// Env vars:
//   OBS_HTTPS=true          → adds Secure flag to cookie (required over HTTPS)
//   NODE_ENV=production     → same effect as OBS_HTTPS=true
//
// Flow:
//   POST /api/auth/login  → verify bcrypt → issue JWT in httpOnly cookie
//   GET  /api/auth/me     → decode cookie → return { username, project }
//   POST /api/auth/logout → clear cookie
//   All other /api/* routes → require valid cookie → inject req.user

'use strict';

const jwt = require('jsonwebtoken');
const redis = require('../../src/utils/redis');

const COOKIE_NAME  = 'tmq_token';
const JWT_EXPIRES  = '24h';

// Public routes — no token required
const PUBLIC_ROUTES = new Set([
  'POST /api/auth/login',
  'GET /api/auth/me',       // returns null if not logged in (used by UI to check state)
  'OPTIONS /',
]);

/**
 * Whether to set the Secure flag on cookies.
 * Required when the dashboard is served over HTTPS.
 * Automatically true in production or when OBS_HTTPS=true.
 */
const USE_SECURE_COOKIE =
  process.env.OBS_HTTPS === 'true' ||
  process.env.NODE_ENV  === 'production';

/**
 * Build cookie string for Set-Cookie header.
 * httpOnly    — JS cannot read it (XSS-safe).
 * SameSite=Lax — works for same-site and cross-subdomain API calls.
 * Secure      — set automatically over HTTPS (required by browsers).
 * Path=/      — valid for all routes.
 */
function buildCookie(token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (USE_SECURE_COOKIE) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(cookieHeader = '') {
  const out = {};
  cookieHeader.split(';').forEach(part => {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k.trim()] = rest.join('=').trim();
  });
  return out;
}

function clearCookie() {
  return buildCookie('', 0); // Max-Age=0 instructs browser to delete it
}

/**
 * Create auth route handlers.
 *
 * @param {import('../observability-core/SetupManager').SetupManager} setup
 * @param {string} jwtSecret
 * @returns {{ handleLogin, handleMe, handleLogout, requireAuth }}
 */
function createAuth(setup, jwtSecret, allowedOrigins = []) {

  // ── POST /api/auth/login ─────────────────────────────────────────────
  async function handleLogin(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limitKey = `taurusmq:obs:ratelimit:login:${ip}`;
    const now = Date.now();
    try {
      const [allowed, waitTime] = await redis.rateLimit(limitKey, now, 60000, 5); // 5 attempts per minute
      if (allowed === 0) {
        res.writeHead(429, { 
          'Content-Type': 'application/json',
          'Retry-After': Math.ceil(waitTime / 1000)
        });
        return res.end(JSON.stringify({ 
          error: `Too many login attempts. Please try again in ${Math.ceil(waitTime / 1000)} seconds.` 
        }));
      }
    } catch (err) {
      console.error('[obs] Login rate limiter error:', err);
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    await new Promise(resolve => req.on('end', resolve));

    let username, password;
    try {
      ({ username, password } = JSON.parse(body));
    } catch {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }

    if (!username || !password) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'username and password required' }));
    }

    // Load stored credentials for username comparison
    const config = setup.load();
    if (username !== config.username) {
      // Uniform response — don't reveal whether username or password was wrong
      await new Promise(r => setTimeout(r, 300)); // timing attack mitigation
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Invalid credentials' }));
    }

    const valid = await setup.verifyPassword(password);
    if (!valid) {
      await new Promise(r => setTimeout(r, 300));
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Invalid credentials' }));
    }

    // Issue JWT
    const payload = { username: config.username, project: config.project };
    const token   = jwt.sign(payload, jwtSecret, { expiresIn: JWT_EXPIRES });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   buildCookie(token, 86400), // 24h
    });
    res.end(JSON.stringify({ ok: true, username: config.username, project: config.project }));
  }

  // ── GET /api/auth/me ─────────────────────────────────────────────────
  function handleMe(req, res) {
    if (process.env.TAURUSMQ_AUTH_DISABLED === 'true') {
      res.writeHead(200);
      return res.end(JSON.stringify({ authenticated: true, username: 'anonymous', project: 'local' }));
    }
    const cookies = parseCookies(req.headers.cookie);
    const token   = cookies[COOKIE_NAME];
    if (!token) {
      res.writeHead(200);
      return res.end(JSON.stringify({ authenticated: false }));
    }
    try {
      const decoded = jwt.verify(token, jwtSecret);
      res.writeHead(200);
      res.end(JSON.stringify({ authenticated: true, username: decoded.username, project: decoded.project }));
    } catch {
      res.writeHead(200);
      res.end(JSON.stringify({ authenticated: false }));
    }
  }

  // ── POST /api/auth/logout ─────────────────────────────────────────────
  function handleLogout(req, res) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   clearCookie(),
    });
    res.end(JSON.stringify({ ok: true }));
  }

  // ── Middleware: requireAuth ───────────────────────────────────────────
  // Call at the top of every protected route handler.
  // Returns decoded payload if valid, writes 401 and returns null if not.
  function requireAuth(req, res) {
    if (process.env.TAURUSMQ_AUTH_DISABLED === 'true') {
      req.user = { username: 'anonymous', project: 'local' };
      return req.user;
    }
    const routeKey = `${req.method} ${new URL(req.url, 'http://localhost').pathname}`;
    if (PUBLIC_ROUTES.has(routeKey)) return true; // skip check

    // CSRF and Origin checks on state-mutating requests
    if (!['GET', 'OPTIONS', 'HEAD'].includes(req.method)) {
      const csrfHeader = req.headers['x-taurusmq-csrf'];
      const requestedWith = req.headers['x-requested-with'];
      if (!csrfHeader && requestedWith !== 'XMLHttpRequest') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CSRF validation failed: Missing custom headers' }));
        return null;
      }
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CSRF validation failed: Origin not allowed' }));
        return null;
      }
    }

    const cookies = parseCookies(req.headers.cookie);
    const token   = cookies[COOKIE_NAME];

    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — no session' }));
      return null;
    }

    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded; // inject into request for downstream use
      return decoded;
    } catch (err) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — session expired or invalid' }));
      return null;
    }
  }

  return { handleLogin, handleMe, handleLogout, requireAuth };
}

module.exports = { createAuth };
