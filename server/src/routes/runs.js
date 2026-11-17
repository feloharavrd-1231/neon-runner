import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, now } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

const MAX_SPEED_UNITS = 42;      // أعلى من MAX_SPEED الفعلي (40) كهامش
const MAX_PAUSE_MS    = 5 * 60_000;

/* ── بدء جولة: السيرفر يسجّل وقت البداية ── */
router.post('/start', (req, res) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO runs (id, user_id, started_at) VALUES (?,?,?)`)
    .run(id, req.userId, now());
  res.json({ runId: id, startedAt: now() });
});

/* ── إنهاء جولة: التحقق من صحة النتيجة ── */
const Finish = z.object({
  runId: z.string().uuid(),
  score: z.number().int().min(0).max(50_000_000),
  gems: z.number().int().min(0).max(1_000_000),
  distance: z.number().int().min(0).max(5_000_000),
  durationMs: z.number().int().min(3000).max(6 * 3600_000)
});

router.post('/finish', (req, res) => {
  const p = Finish.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'بيانات غير صالحة' });
  const { runId, score, gems, distance, durationMs } = p.data;

  const run = db.prepare(
    `SELECT * FROM runs WHERE id = ? AND user_id = ?`
  ).get(runId, req.userId);

  if (!run)              return res.status(404).json({ error: 'جولة غير معروفة' });
  if (run.finished)      return res.status(409).json({ error: 'الجولة مُسجّلة مسبقاً' });

  const elapsed = now() - run.started_at;

  // 1) مدة اللعب لا يمكن أن تتجاوز الزمن الحقيقي المنقضي
  if (durationMs > elapsed + 3000) {
    return res.status(400).json({ error: 'مدة الجولة غير منطقية' });
  }
  // 2) حد أقصى للوقت المتوقف (إعلانات/غش)
  if (run.paused_ms > MAX_PAUSE_MS) {
    return res.status(400).json({ error: 'توقف طويل غير مسموح' });
  }
  // 3) المسافة ≤ السرعة القصوى × الزمن
  const maxDistance = (MAX_SPEED_UNITS * durationMs) / 1000 + 5;
  if (distance > maxDistance) {
    return res.status(400).json({ error: 'نتيجة مستحيلة (مسافة)' });
  }
  // 4) الجواهر ≤ معدّل التوليد المعقول
  if (gems > distance * 0.4 + 60) {
    return res.status(400).json({ error: 'نتيجة مستحيلة (جواهر)' });
  }
  // 5) النقاط = المسافة + الجواهر × 10 (± هامش بسيط)
  if (score > distance + gems * 10 + 5) {
    return res.status(400).json({ error: 'نتيجة مستحيلة (نقاط)' });
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE runs SET finished = 1 WHERE id = ?`).run(runId);
    db.prepare(
      `INSERT INTO scores (user_id, run_id, score, gems, distance, duration_ms, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(req.userId, runId, score, gems, distance, durationMs, now());

    const cur = db.prepare(`SELECT score FROM bests WHERE user_id = ?`).get(req.userId);
    if (!cur) {
      db.prepare(
        `INSERT INTO bests (user_id, score, gems, distance, updated_at) VALUES (?,?,?,?,?)`
      ).run(req.userId, score, gems, distance, now());
    } else if (score > cur.score) {
      db.prepare(
        `UPDATE bests SET score = ?, gems = ?, distance = ?, updated_at = ? WHERE user_id = ?`
      ).run(score, gems, distance, now(), req.userId);
    }
  });
  tx();

  const best = db.prepare(`SELECT score FROM bests WHERE user_id = ?`).get(req.userId);
  res.json({ ok: true, score, best: best.score });
});

/* ── طلب إحياء بعد مشاهدة إعلان ── */
router.post('/:runId/revive/request', (req, res) => {
  const max = Number(process.env.MAX_REVIVES_PER_RUN || 2);

  const run = db.prepare(
    `SELECT * FROM runs WHERE id = ? AND user_id = ?`
  ).get(req.params.runId, req.userId);
  if (!run || run.finished) return res.status(404).json({ error: 'جولة غير صالحة' });

  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM revives WHERE run_id = ?`
  ).get(run.id);
  if (n >= max) return res.status(429).json({ error: 'لا مزيد من الإحياءات' });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO revives (id, run_id, user_id, created_at) VALUES (?,?,?,?)`
  ).run(id, run.id, req.userId, now());

  res.json({
    reviveId: id,
    adUnit: process.env.ADMOB_AD_UNIT_REWARDED,
    expiresAt: now() + 3 * 60_000,
    remaining: max - n - 1
  });
});

/* ── حالة الإحياء (Client يسأل بعد الإعلان) ── */
router.get('/revive/:reviveId/status', (req, res) => {
  const r = db.prepare(
    `SELECT * FROM revives WHERE id = ? AND user_id = ?`
  ).get(req.params.reviveId, req.userId);
  if (!r) return res.status(404).json({ error: 'غير موجود' });

  if (r.used_at)     return res.json({ status: 'used' });
  if (r.rewarded_at) return res.json({ status: 'rewarded' });
  if (now() - r.created_at > 3 * 60_000) return res.json({ status: 'expired' });
  res.json({ status: 'pending' });
});

/* ── استهلاك الإحياء ── */
router.post('/revive/:reviveId/claim', (req, res) => {
  const r = db.prepare(
    `SELECT * FROM revives WHERE id = ? AND user_id = ?`
  ).get(req.params.reviveId, req.userId);
  if (!r)            return res.status(404).json({ error: 'غير موجود' });
  if (r.used_at)     return res.status(409).json({ error: 'مُستخدَم مسبقاً' });
  if (!r.rewarded_at) {
    // وضع التطوير فقط — لا يعمل أبداً في الإنتاج
    if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AD_REWARD === 'true') {
      db.prepare(`UPDATE revives SET rewarded_at = ? WHERE id = ?`).run(now(), r.id);
    } else {
      return res.status(403).json({ error: 'لم يتم التحقق من الإعلان' });
    }
  }

  const paused = now() - r.created_at;
  db.transaction(() => {
    db.prepare(`UPDATE revives SET used_at = ? WHERE id = ?`).run(now(), r.id);
    db.prepare(`UPDATE runs SET paused_ms = paused_ms + ? WHERE id = ?`).run(paused, r.run_id);
  })();

  res.json({ ok: true });
});

export default router;
