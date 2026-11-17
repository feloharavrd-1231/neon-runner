import { api, ApiError } from '/api.js';
import { NeonRunner } from '/game.js';

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

let user = null;
let currentRunId = null;
let pendingRunResult = null;
let pendingReviveId = null;
let revivesLeft = 0;
let stats = { best: 0, rank: null, games: 0 };

/* ═══════ Toast ═══════ */
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), ms);
}

/* ═══════ تهيئة المحرك ═══════ */
const game = new NeonRunner($('gl'), {
  onHud(h) {
    $('hScore').textContent = h.score;
    $('hGems').textContent = h.gems;
    $('hSpeed').style.width = h.speedPct.toFixed(1) + '%';
  },
  onGameOver: handleGameOver
});

/* ═══════ التنقل بين الشاشات ═══════ */
function screen(name) {
  ['screen-auth', 'screen-menu', 'screen-lb', 'screen-over'].forEach(id => {
    hide($(id));
  });
  if (name) show($('screen-' + name));
}

function setHud(visible) {
  $('hud').classList.toggle('hidden', !visible);
}

/* ═══════ المصادقة ═══════ */
let mode = 'login';

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    mode = t.dataset.tab;
    $('fUser').hidden = mode !== 'register';
    $('authSubmit').textContent = mode === 'register' ? 'إنشاء الحساب' : 'تسجيل الدخول';
    $('fPass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    hide($('authErr'));
  };
});

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('authSubmit');
  hide($('authErr'));
  btn.disabled = true;
  btn.textContent = 'جارٍ…';
  try {
    const email = $('fEmail').value.trim();
    const pass = $('fPass').value;
    user = mode === 'register'
      ? await api.register(email, $('fUser').value.trim(), pass)
      : await api.login(email, pass);
    $('fPass').value = '';
    await enterMenu();
  } catch (err) {
    const m = $('authErr');
    m.textContent = err instanceof ApiError ? err.message : 'تعذّر الاتصال بالخادم';
    show(m);
  } finally {
    btn.disabled = false;
    btn.textContent = mode === 'register' ? 'إنشاء الحساب' : 'تسجيل الدخول';
  }
};

/* اللعب كضيف — بدون حفظ نتائج */
let guestMode = false;
$('guestBtn').onclick = async () => {
  guestMode = true;
  user = { username: 'ضيف', id: null };
  $('mUser').textContent = 'ضيف';
  $('mBest').textContent = '—';
  $('mRank').textContent = '—';
  $('mGames').textContent = '—';
  hide($('logoutBtn'));
  screen('menu');
};

$('logoutBtn').onclick = async () => {
  await api.logout();
  user = null; guestMode = false;
  screen('auth');
  show($('logoutBtn'));
};

api.setUnauthorizedHandler(() => {
  if (user && !guestMode) { toast('انتهت الجلسة، سجّل الدخول مجدداً'); screen('auth'); }
});

/* ═══════ القائمة ═══════ */
async function enterMenu() {
  $('mUser').textContent = user.username;
  screen('menu');
  setHud(false);
  if (!guestMode) await refreshStats();
}

async function refreshStats() {
  try {
    stats = await api.myStats();
    $('mBest').textContent = stats.best;
    $('mRank').textContent = stats.rank ? '#' + stats.rank : '—';
    $('mGames').textContent = stats.games;
  } catch { /* تجاهل */ }
}

$('playBtn').onclick = startRun;
$('againBtn').onclick = startRun;
$('menuBtn').onclick = async () => {
  try {
    await finishPendingRun();
    screen('menu');
    setHud(false);
    if (!guestMode) await refreshStats();
  } catch (e) {
    toast(e.message || 'تعذّر حفظ النتيجة');
  }
};

async function startRun() {
  try {
    await finishPendingRun();
  } catch (e) {
    toast(e.message || 'تعذّر حفظ النتيجة');
    return;
  }

  guestMode = guestMode || !user?.id;
  currentRunId = null;
  if (!guestMode) {
    try {
      const d = await api.startRun();
      currentRunId = d.runId;
    } catch { toast('تعذّر بدء الجولة، تلعب كضيف'); guestMode = true; }
  }
  hide($('screen-over'));
  screen(null);
  setHud(true);
  $('reviveBtn').disabled = false;
  $('adErr').hidden = true;
  game.start();
}

async function finishPendingRun() {
  if (!pendingRunResult) return;
  if (!guestMode && currentRunId) {
    const result = await api.finishRun({ runId: currentRunId, ...pendingRunResult });
    stats.best = result.best;
  }
  pendingRunResult = null;
  currentRunId = null;
  if (!guestMode) await refreshStats();
}

/* ═══════ نهاية اللعبة ═══════ */
function handleGameOver(result) {
  pendingRunResult = result;
  $('oScore').textContent = result.score;
  $('oGems').textContent = result.gems;
  $('oBest').textContent = Math.max(stats.best || 0, result.score);

  // هل يستطيع الإحياء؟
  const canRevive = !guestMode && currentRunId;
  $('reviveBtn').classList.toggle('hidden', !canRevive);
  $('adNote').textContent = canRevive
    ? 'إحياء واحد لكل إعلان — تُحفظ النتيجة عند إنهاء الجولة'
    : 'سجّل الدخول لتتمكن من الإحياء وحفظ نتائجك';

  setHud(false);
  screen('over');
}

/* ═══════ الإحياء بالإعلان ═══════ */
$('reviveBtn').onclick = async () => {
  const btn = $('reviveBtn');
  btn.disabled = true;
  $('adErr').hidden = true;

  try {
    const { reviveId, adUnit } = await api.requestRevive(currentRunId);
    pendingReviveId = reviveId;

    await showRewardedAd(reviveId, adUnit);

    // ننتظر تأكيد Google (SSV) — قد يستغرق لحظات
    const ok = await pollRevive(reviveId, 15000);
    if (!ok) throw new Error('لم يصل تأكيد الإعلان. حاول لاحقاً.');

    await api.claimRevive(reviveId);
    pendingReviveId = null;

    if (!game.revive()) throw new Error('تعذّر استكمال الجولة');
    pendingRunResult = null;
    hide($('screen-over'));
    screen(null);
    setHud(true);
    toast('عدت للمسار! 🚀', 1600);

  } catch (e) {
    const m = $('adErr');
    m.textContent = e.message || 'فشل الإعلان';
    show(m);
  } finally {
    btn.disabled = false;
  }
};

async function pollRevive(id, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 900));
    try {
      const { status } = await api.reviveStatus(id);
      if (status === 'rewarded') return true;
      if (status === 'expired' || status === 'used') return false;
    } catch { /* تابع المحاولة */ }
  }
  return false;
}

/**
 * تشغيل الإعلان المكافئ.
 * - على أندرويد (Capacitor + AdMob): يستدعي الوحدة الحقيقية ويمرّر reviveId كـ customData
 *   حتى تتحقق Google من الطلب عبر SSV على السيرفر.
 * - على الويب: لا يوجد AdMob، لذلك نُظهر رسالة.
 */
async function showRewardedAd(reviveId, adUnit) {
  const native = !!window.Capacitor?.isNativePlatform?.();
  if (!native) {
    throw new Error('الإعلانات المتاحة في تطبيق أندرويد فقط. على الويب جرّب عبر التطبيق.');
  }
  const { AdMob, RewardAdPluginEvents } = await import('@capacitor-community/admob');

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = async () => {
      try { await AdMob.removeAllListeners(); } catch {}
    };

    AdMob.addListener(RewardAdPluginEvents.Rewarded, async (reward) => {
      if (settled) return;
      settled = true;
      // ملاحظة: لا نعتمد على هذا الحدث للأمان — السيرفر ينتظر SSV من Google
      await cleanup();
      resolve(reward);
    });

    AdMob.addListener(RewardAdPluginEvents.Dismissed, async () => {
      if (settled) return;
      settled = true;
      await cleanup();
      // لا نرفض فوراً: ربما وصل SSV قبل الإغلاق
      resolve(null);
    });

    AdMob.addListener(RewardAdPluginEvents.FailedToLoad, async (e) => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(new Error('تعذّر تحميل الإعلان'));
    });

    (async () => {
      try {
        await AdMob.prepareRewardVideoAd({
          adId: adUnit,
          // ← هذا هو المفتاح: Google تعيده في callback الـ SSV
          customData: reviveId,
          // اختياري: مرّر معرّف المستخدم ليتطابق مع فحص السيرفر
          ssv: { userId: String(user?.id ?? '') }
        });
        await AdMob.showRewardVideoAd();
      } catch (e) {
        if (!settled) { settled = true; await cleanup(); reject(new Error('فشل عرض الإعلان')); }
      }
    })();
  });
}

/* ═══════ لوحة الصدارة ═══════ */
$('lbBtn').onclick = async () => {
  screen('lb');
  const list = $('lbList');
  list.innerHTML = '<p class="muted" style="padding:18px">جارٍ التحميل…</p>';
  try {
    const { entries } = await api.leaderboard(50);
    if (!entries.length) { list.innerHTML = '<p class="muted" style="padding:18px">لا نتائج بعد</p>'; return; }
    list.innerHTML = entries.map(e => `
      <div class="lb-row${e.username === user?.username ? ' me' : ''}">
        <span class="r">#${e.rank}</span>
        <span class="n">${escapeHtml(e.username)}</span>
        <span class="s">${e.score.toLocaleString('ar-EG')}</span>
      </div>`).join('');
  } catch {
    list.innerHTML = '<p class="muted" style="padding:18px">تعذّر التحميل</p>';
  }
};
$('lbBack').onclick = () => { screen('menu'); refreshStats(); };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ═══════ الصوت ═══════ */
let soundOn = localStorage.getItem('rn_sound') !== 'off';
game.setSound(soundOn);
$('soundBtn').textContent = soundOn ? '🔊 الصوت' : '🔇 صامت';
$('soundBtn').onclick = () => {
  soundOn = !soundOn;
  game.setSound(soundOn);
  localStorage.setItem('rn_sound', soundOn ? 'on' : 'off');
  $('soundBtn').textContent = soundOn ? '🔊 الصوت' : '🔇 صامت';
};

/* ═══════ إخفاء الشاشة عند تبديل التطبيق ═══════ */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause(); else game.resume();
});

/* ═══════ الإقلاع ═══════ */
(async function boot() {
  try {
    const u = await api.restore();
    if (u) { user = u; await enterMenu(); return; }
  } catch { /* لا جلسة */ }
  screen('auth');
})();
