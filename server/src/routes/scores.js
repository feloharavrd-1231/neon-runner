import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

/** لوحة الصدارة العامة (لا تحتاج تسجيل دخول) */
router.get('/leaderboard', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const rows = db.prepare(`
    SELECT u.username, b.score, b.gems, b.updated_at
    FROM bests b
    JOIN users u ON u.id = b.user_id
    WHERE u.banned = 0 AND b.score > 0
    ORDER BY b.score DESC, b.updated_at ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    entries: rows.map((r, i) => ({
      rank: offset + i + 1,
      username: r.username,
      score: r.score,
      gems: r.gems,
      updatedAt: r.updated_at
    }))
  });
});

/** ترتيب المستخدم الحالي + إحصائياته */
router.get('/me', requireAuth, (req, res) => {
  const best = db.prepare(`SELECT * FROM bests WHERE user_id = ?`).get(req.userId)
            || { score: 0, gems: 0, distance: 0 };

  const { rank } = best.score > 0
    ? db.prepare(`SELECT COUNT(*) + 1 AS rank FROM bests WHERE score > ?`).get(best.score)
    : { rank: null };

  const { games } = db.prepare(
    `SELECT COUNT(*) AS games FROM scores WHERE user_id = ?`
  ).get(req.userId);

  res.json({
    best: best.score,
    gems: best.gems,
    distance: best.distance,
    rank,
    games,
    updatedAt: best.updated_at || null
  });
});

export default router;
