import { Router } from 'express';
import { db, now } from '../db.js';
import { verifySsv } from '../ssv.js';

const router = Router();

/**
 * AdMob Server-Side Verification callback.
 * Google تتصل بهذا المسار مباشرة بعد أن يُكمل المستخدم الإعلان.
 * لا يمكن للعميل استدعاؤه بنجاح لأنه لا يملك مفتاح التوقيع الخاص.
 */
router.get('/ssv', async (req, res) => {
  if (process.env.ADMOB_SSV_ENABLED !== 'true') {
    return res.status(503).send('ssv disabled');
  }

  const raw = req.originalUrl.split('?')[1] || '';
  const cut = raw.lastIndexOf('&signature=');
  if (cut < 0) return res.status(400).send('bad request');

  const signedPart = raw.slice(0, cut);
  const q = req.query;

  try {
    const ok = await verifySsv(signedPart, q.key_id, String(q.signature || ''));
    if (!ok) return res.status(403).send('bad signature');
  } catch (e) {
    console.error('SSV verify error:', e.message);
    return res.status(400).send('verify failed');
  }

  // التحقق من هوية التطبيق/الوحدة الإعلانية
  if (String(q.ad_unit) !== String(process.env.ADMOB_AD_UNIT_REWARDED)) {
    return res.status(403).send('wrong ad unit');
  }

  const reviveId = String(q.custom_data || '');
  const r = db.prepare(`SELECT * FROM revives WHERE id = ?`).get(reviveId);
  if (!r) return res.status(404).send('unknown revive');

  // Google ترسل user_id الذي مرّرناه من العميل — نتحقق أنه صاحب الإحياء
  if (String(q.user_id) !== String(r.user_id)) {
    return res.status(403).send('user mismatch');
  }

  if (!r.rewarded_at) {
    db.prepare(`UPDATE revives SET rewarded_at = ? WHERE id = ?`).run(now(), r.id);
  }

  // Google تتوقع استجابة 200
  res.status(200).send('ok');
});

export default router;
