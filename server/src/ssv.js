import crypto from 'node:crypto';

const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
let cache = { at: 0, keys: new Map() };

async function loadKeys() {
  if (Date.now() - cache.at < 6 * 3600_000 && cache.keys.size) return cache.keys;
  const r = await fetch(KEYS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('تعذّر جلب مفاتيح AdMob');
  const { keys = [] } = await r.json();
  const m = new Map();
  for (const k of keys) m.set(String(k.keyId), k.pem);
  cache = { at: Date.now(), keys: m };
  return m;
}

/** rawQuery = كل نص الاستعلام قبل &signature= */
export async function verifySsv(rawQuery, keyId, signature) {
  const keys = await loadKeys();
  const pem = keys.get(String(keyId));
  if (!pem) throw new Error('key_id غير معروف');

  const b64 = signature.replace(/-/g, '+').replace(/_/g, '/');
  const sig = Buffer.from(b64, 'base64');

  return crypto.verify(
    'sha256',
    Buffer.from(rawQuery, 'utf8'),
    { key: pem, dsaEncoding: 'der' },
    sig
  );
}
