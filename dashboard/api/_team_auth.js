/**
 * Shared helpers for the team sign-in (/api/team-login) and the endpoints only a
 * signed-in team member may write through (/api/valuation-inputs PUT).
 * Vercel does not route files whose name starts with "_", so this is not an endpoint.
 *
 * Session: one shared team password (TEAM_PASSWORD) buys a cookie holding an
 * expiry and its HMAC-SHA256 under TEAM_SESSION_SECRET:
 *   team_session=<exp>.<base64url hmac>     exp = Unix seconds
 * Nothing else is stored, so rotating the secret signs everyone out.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'team_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;   // 30 days, in seconds
const NO_STORE = 'private, no-store';

function hmac(secret, exp) {
  return crypto.createHmac('sha256', secret).update(`team:${exp}`).digest('base64url');
}

// Equal-length buffers for timingSafeEqual: compare SHA-256 digests, so neither
// the length nor the content of the expected value leaks through timing.
function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

function passwordMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  return safeEqual(given, expected);
}

function signSession(exp, secret) {
  return `${exp}.${hmac(secret, exp)}`;
}

// True only for a well-formed, unexpired value signed with `secret`. An expiry
// further ahead than one session (a forged or stale-format value) is refused too.
function verifySession(value, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof value !== 'string') return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > nowSec) || exp > nowSec + SESSION_MAX_AGE + 60) return false;
  return safeEqual(m[2], hmac(secret, m[1]));
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) return;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
    out[k] = v;
  });
  return out;
}

function isSignedIn(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return verifySession(cookies[COOKIE_NAME], process.env.TEAM_SESSION_SECRET);
}

function sessionCookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;
}

function clientIp(req) {
  const h = req.headers || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(h['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// A request body as an object: Vercel parses JSON bodies, but a body sent as
// text (or a JSON string) arrives as a string. Anything else → {}.
function readBody(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  if (typeof body === 'string') {
    try {
      const j = JSON.parse(body);
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch (e) { /* not JSON */ }
    return Object.fromEntries(new URLSearchParams(body));
  }
  return {};
}

module.exports = {
  COOKIE_NAME, SESSION_MAX_AGE, NO_STORE,
  passwordMatches, signSession, verifySession, parseCookies, isSignedIn, sessionCookie, clientIp, readBody,
};
