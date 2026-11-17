import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, now } from '../db.js';
import {
  signAccess, issueRefresh, rotateRefresh, revokeRefresh,
  readRefreshToken, setRefreshCookie, clearRefreshCookie, requireAuth
} from '../auth.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة، حاول لاحقاً' }
});

const Password = z.string().min(8).max(128);

const Credentials = z.object({
  email: z.string().email().max(160),
  password: Password
});

const Register = Credentials.extend({
  password: Password
    .regex(/[A-Za-z]/, 'يجب أن تحتوي كلمة المرور على حرف')
    .regex(/[0-9]/, 'يجب أن تحتوي كلمة المرور على رقم'),
  username: z.string().min(3).max(20).regex(/^[A-Za-z0-9_\u0600-\u06FF]+$/, 'اسم مستخدم غير صالح')
});

function publicUser(u) {
  return { id: u.id, email: u.email, username: u.username, createdAt: u.created_at };
}

function startSession(res, user) {
  const access = signAccess(user);
  const refresh = issueRefresh(user.id);
  setRefreshCookie(res, refresh);
  // نُعيد الـ refresh في الجسم ليستخدمه تطبيق أندرويد (لا كوكيز في Capacitor)
  res.json({ accessToken: access, refreshToken: refresh, user: publicUser(user) });
}

router.post('/register', authLimiter, async (req, res) => {
  const p = Register.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const { email, username, password } = p.data;

  const exists = db.prepare(
    `SELECT 1 FROM users WHERE email = ? OR username = ?`
  ).get(email, username);
  if (exists) return res.status(409).json({ error: 'البريد أو اسم المستخدم مستخدم مسبقاً' });

  const hash = await bcrypt.hash(password, 12);
  const info = db.prepare(
    `INSERT INTO users (email, username, password_hash, created_at) VALUES (?,?,?,?)`
  ).run(email, username, hash, now());

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO bests (user_id, score, gems, distance, updated_at) VALUES (?,0,0,0,?)`
  ).run(user.id, now());

  startSession(res, user);
});

router.post('/login', authLimiter, async (req, res) => {
  const p = Credentials.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'بيانات غير صالحة' });

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(p.data.email);
  // نفس الاستجابة دائماً لمنع تعداد الحسابات
  if (!user || user.banned) {
    await bcrypt.hash('dummy', 10);
    return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
  }
  const ok = await bcrypt.compare(p.data.password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });

  startSession(res, user);
});

router.post('/refresh', (req, res) => {
  const out = rotateRefresh(readRefreshToken(req));
  if (!out) {
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'انتهت الجلسة' });
  }
  setRefreshCookie(res, out.refreshToken);
  res.json({
    accessToken: signAccess(out.user),
    refreshToken: out.refreshToken,
    user: publicUser(out.user)
  });
});

router.post('/logout', (req, res) => {
  revokeRefresh(readRefreshToken(req));
  clearRefreshCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  res.json({ user: publicUser(u) });
});

/** حذف الحساب — مطلوب إلزامياً من Google Play للتطبيقات التي فيها تسجيل دخول */
router.delete('/me', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const ok = await bcrypt.compare(String(password || ''), u.password_hash);
  if (!ok) return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });

  db.prepare(`DELETE FROM users WHERE id = ?`).run(u.id); // CASCADE يحذف الباقي
  clearRefreshCookie(res);
  res.json({ ok: true });
});

export default router;
