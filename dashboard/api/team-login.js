/**
 * Vercel Serverless Function: /api/team-login
 *
 * Signs a viewer in as a team member with the shared team password, for the
 * edits only the team may make (the shared valuation inputs).
 *   GET  /api/team-login               → 200 {signed_in: bool} (no-store), so the page can ask
 *   POST /api/team-login               body {"password": "…"}
 *        → 204 + Set-Cookie team_session (HttpOnly, Secure, SameSite=Strict, Path=/api, 30 days)
 *        → 401 wrong password, 429 after 5 failures from one IP in 10 minutes
 *   POST /api/team-login?logout=1      → 204 + an expired cookie
 *
 * Env: TEAM_PASSWORD, TEAM_SESSION_SECRET. Either missing → 503 (fails closed).
 * The failure count is per function instance and in memory: best effort, it
 * slows guessing but is not a lockout.
 */

const {
  NO_STORE, SESSION_MAX_AGE, passwordMatches, signSession, sessionCookie, clientIp, isSignedIn, readBody,
} = require('./_team_auth');

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const FAILURES = new Map();   // ip → [failure times, ms]

function recentFailures(ip, now) {
  const list = (FAILURES.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length) FAILURES.set(ip, list); else FAILURES.delete(ip);
  // Keep the map small on a long-lived instance
  if (FAILURES.size > 5000) FAILURES.delete(FAILURES.keys().next().value);
  return list;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', NO_STORE);
  if (req.method === 'GET') {
    return res.status(200).json({ signed_in: isSignedIn(req) });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if ((req.query || {}).logout === '1') {
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return res.status(204).end();
  }

  const expected = process.env.TEAM_PASSWORD;
  const secret = process.env.TEAM_SESSION_SECRET;
  if (!expected || !secret) {
    return res.status(503).json({ error: 'Team sign-in is not configured' });
  }

  const ip = clientIp(req);
  const now = Date.now();
  const failures = recentFailures(ip, now);
  if (failures.length >= MAX_FAILURES) {
    const retry = Math.max(1, Math.ceil((failures[0] + WINDOW_MS - now) / 1000));
    res.setHeader('Retry-After', String(retry));
    return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
  }

  if (!passwordMatches(readBody(req.body).password, expected)) {
    failures.push(now);
    FAILURES.set(ip, failures);
    return res.status(401).json({ error: 'Wrong password' });
  }

  FAILURES.delete(ip);
  const exp = Math.floor(now / 1000) + SESSION_MAX_AGE;
  res.setHeader('Set-Cookie', sessionCookie(signSession(exp, secret), SESSION_MAX_AGE));
  return res.status(204).end();
};
