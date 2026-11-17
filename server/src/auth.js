import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { db, now } from './db.js';

const ACCESS_TTL   = '15m';
const REFRESH_TTL  = 30 * 24 * 3600 * 1000; // 30 يوماً
export const REFRESH_HEADER = 'x-refresh-token';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function signAccess(user) {
  return jwt.sign(
    { sub: user.id, u: user.username },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL, issuer: 'neon-runner', audience: 'neon-runner-app' }
  );
}

export function issueRefresh(userId) {
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)`
  ).run(sha(raw), userId, now() + REFRESH_TTL, now());
  return raw;
}

/** يدوّر التوكن: يحذف القديم ويصدر جديداً (كشف إعادة الاستخدام) */
export function rotateRefresh(rawToken) {
  if (!rawToken) return null;
  const row = db.prepare(
    `SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = ?`
  ).get(sha(rawToken));
  if (!row) return null;
  db.prepare(`DELETE FROM refresh_tokens WHERE token_hash = ?`).run(sha(rawToken));
  if (row.expires_at < now()) return null;
  const user = db.prepare(
    `SELECT id, email, username, created_at FROM users WHERE id = ? AND banned = 0`
  ).get(row.user_id);
  if (!user) return null;
  return { user, refreshToken: issueRefresh(user.id) };
}

export function revokeRefresh(rawToken) {
  if (rawToken) db.prepare(`DELETE FROM refresh_tokens WHERE token_hash = ?`).run(sha(rawToken));
}

/** يقرأ التوكن من الكوكي (ويب) أو من الترويسة (تطبيق أندرويد) */
export function readRefreshToken(req) {
  return req.cookies?.rn_rt || req.get(REFRESH_HEADER) || null;
}

export function setRefreshCookie(res, token) {
  res.cookie('rn_rt', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TTL,
    path: '/api/auth'
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie('rn_rt', { path: '/api/auth' });
}

/** Middleware: يتحقق من توكن الوصول */
export function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرّح' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'neon-runner', audience: 'neon-runner-app'
    });
    req.userId = Number(p.sub);
    req.username = p.u;
    next();
  } catch {
    return res.status(401).json({ error: 'توكن منتهي أو غير صالح' });
  }
}
