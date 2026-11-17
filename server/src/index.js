import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import './db.js';
import authRoutes from './routes/auth.js';
import runRoutes from './routes/runs.js';
import scoreRoutes from './routes/scores.js';
import adRoutes from './routes/ads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const VENDOR = path.join(PUBLIC_DIR, 'vendor/three.module.js');
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET مفقود أو قصير جداً (32 حرفاً على الأقل)');
  process.exit(1);
}

/* ── تنزيل Three.js محلياً (بدل CDN) ── */
async function ensureThree() {
  try {
    if (fs.statSync(VENDOR).size > 0) return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  console.log('⬇️  تنزيل Three.js ...');
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  const url = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('فشل تنزيل Three.js');
  const source = await r.text();
  if (!source.includes('WebGLRenderer')) throw new Error('ملف Three.js الذي تم تنزيله غير صالح');
  const temp = `${VENDOR}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, source);
    fs.renameSync(temp, VENDOR);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  console.log('✅ Three.js جاهز');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ── CORS ── */
const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const sameOrigin = req.get('origin') === `${req.protocol}://${req.get('host')}`;
  cors({
    origin(origin, cb) {
      // نسمح بلا origin (تطبيقات native / curl) أو بنفس أصل الخادم.
      if (!origin || sameOrigin || allowed.includes(origin)) return cb(null, true);
      cb(new Error('origin غير مسموح'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Refresh-Token']
  })(req, res, next);
});

/* ── Security headers ── */
const apiOrigins = allowed.filter(o => o.startsWith('http')).join(' ');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src':  ["'self'"],
      'script-src':   ["'self'"],
      'style-src':    ["'self'"],
      'img-src':      ["'self'", 'data:', 'blob:'],
      'font-src':     ["'self'"],
      'connect-src':  ["'self'", apiOrigins].filter(Boolean),
      'media-src':    ["'self'"],
      'object-src':   ["'none'"],
      'base-uri':     ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action':  ["'self'"],
      ...(isProd ? { 'upgrade-insecure-requests': [] } : {})
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

/* ── Rate limiting ── */
app.use('/api', rateLimit({
  windowMs: 15 * 60_000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة جداً' }
}));

/* ── المسارات ── */
app.use('/api/auth', authRoutes);
app.use('/api/runs', runRoutes);
app.use('/api/scores', scoreRoutes);
app.use('/api/ads', adRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ── الملفات الثابتة ── */
app.use(express.static(PUBLIC_DIR, {
  maxAge: isProd ? '1h' : 0,
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ── معالج أخطاء ── */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'خطأ في الخادم' });
});

const PORT = Number(process.env.PORT || 8080);
ensureThree()
  .then(() => app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
