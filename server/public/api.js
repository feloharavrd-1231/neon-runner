/**
 * عميل API. توكن الوصول في الذاكرة فقط (مقاوم لـ XSS).
 * توكن التحديث: كوكي httpOnly على الويب، وتخزين آمن على أندرويد.
 */
const BASE = (window.__API_BASE__ || '').replace(/\/$/, '');
const isNative = !!window.Capacitor?.isNativePlatform?.();

let accessToken = null;
let refreshToken = null;          // للـ native فقط
let onUnauthorized = () => {};

/* ── تخزين آمن (native) ── */
async function storeRefresh(t) {
  refreshToken = t;
  if (!isNative || !t) return;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: 'rn_rt', value: t });
  } catch {}
}
async function loadRefresh() {
  if (refreshToken) return refreshToken;
  if (!isNative) return null;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: 'rn_rt' });
    refreshToken = value || null;
  } catch {}
  return refreshToken;
}
async function clearRefresh() {
  await storeRefresh(null);
  if (isNative) {
    try {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.remove({ key: 'rn_rt' });
    } catch {}
  }
}

/* ── طلب أساسي ── */
async function raw(path, { method = 'GET', body, auth = true, retry = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: isNative ? 'omit' : 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new ApiError(0, 'الخادم لم يستجب خلال 15 ثانية. تأكد من تشغيله واستخدام رابط التطبيق الصحيح.');
    }
    throw new ApiError(0, 'تعذّر الاتصال بالخادم. تأكد من تشغيله واستخدام رابط التطبيق الصحيح.');
  }

  if (res.status === 401 && auth && retry) {
    const ok = await tryRefresh();
    if (ok) return raw(path, { method, body, auth, retry: false });
    onUnauthorized();
    throw new ApiError(401, 'انتهت الجلسة');
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) throw new ApiError(res.status, data?.error || `خطأ ${res.status}`, data);
  return data;
}

async function tryRefresh() {
  const rt = await loadRefresh();
  try {
    const res = await fetch(BASE + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(rt ? { 'X-Refresh-Token': rt } : {}) },
      credentials: isNative ? 'omit' : 'include'
    });
    if (!res.ok) { await clearRefresh(); return false; }
    const d = await res.json();
    accessToken = d.accessToken;
    await storeRefresh(d.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/* ── الواجهة العامة ── */
export const api = {
  setUnauthorizedHandler(fn) { onUnauthorized = fn; },
  isLoggedIn: () => !!accessToken,

  async register(email, username, password) {
    const d = await raw('/api/auth/register', {
      method: 'POST', auth: false, body: { email, username, password }
    });
    accessToken = d.accessToken;
    await storeRefresh(d.refreshToken);
    return d.user;
  },

  async login(email, password) {
    const d = await raw('/api/auth/login', {
      method: 'POST', auth: false, body: { email, password }
    });
    accessToken = d.accessToken;
    await storeRefresh(d.refreshToken);
    return d.user;
  },

  /** استعادة الجلسة عند بدء التطبيق */
  async restore() {
    if (!(await tryRefresh())) return null;
    const d = await raw('/api/auth/me');
    return d.user;
  },

  async logout() {
    try { await raw('/api/auth/logout', { method: 'POST', auth: false }); } catch {}
    accessToken = null;
    await clearRefresh();
  },

  deleteAccount(password) {
    return raw('/api/auth/me', { method: 'DELETE', body: { password } });
  },

  /* اللعب */
  startRun()                 { return raw('/api/runs/start', { method: 'POST' }); },
  finishRun(payload)         { return raw('/api/runs/finish', { method: 'POST', body: payload }); },
  requestRevive(runId)       { return raw(`/api/runs/${runId}/revive/request`, { method: 'POST' }); },
  reviveStatus(id)           { return raw(`/api/runs/revive/${id}/status`); },
  claimRevive(id)            { return raw(`/api/runs/revive/${id}/claim`, { method: 'POST' }); },

  /* النتائج */
  myStats()                  { return raw('/api/scores/me'); },
  leaderboard(limit = 50)    { return raw(`/api/scores/leaderboard?limit=${limit}`, { auth: false }); }
};
