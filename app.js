/* ==========================================================================
 *  StudyTrack · 学习打卡网站 —— 应用逻辑
 *  纯原生 JavaScript，零依赖、零构建、零后端：
 *    · 账号体系：用户名 + 密码（SHA-256 加盐摘要）+ 头像，数据存 localStorage
 *    · 学习计时：用户自己「开始 / 结束」，按天累计多段学习记录
 *    · 统计：连续打卡天数、累计时长、日历热力图、成就徽章
 *  不涉及钱包、区块链或任何网络请求。
 * ========================================================================== */

/* ==========================================================================
 *  1. 常量与基础工具
 * ========================================================================== */

const STORAGE_KEY = 'studytrack.v1';
const AVATARS = ['🐳', '🦊', '🐼', '🦉', '🐝', '🌱', '🚀', '📚', '☕', '🎧', '🧠', '⚡'];
const DEFAULT_GOAL = 60;              // 默认每日目标（分钟）
const MAX_SESSION_HOURS = 8;          // 单段计时上限：超时视为忘记关闭
const RING_C = 2 * Math.PI * 52;      // 进度环周长，与 CSS 中的 r 对应
const BASE_TITLE = 'StudyTrack · 学习打卡';
const VIEWS = ['dashboard', 'calendar', 'records', 'achievements', 'settings'];
const VIEW_TITLES = {
  dashboard: '仪表盘', calendar: '打卡日历', records: '学习记录',
  achievements: '成就', settings: '设置'
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const pad = (n) => String(n).padStart(2, '0');

/** HTML 转义，防止用户输入破坏页面结构 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 右下角操作提示 */
function toast(msg, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'info' ? '' : ' ' + type);
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ==========================================================================
 *  2. 日期与时长工具
 * ========================================================================== */

/** 本地日期 → 'YYYY-MM-DD' */
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 'YYYY-MM-DD' → Date（本地零点） */
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** 两个日期相差的天数（按本地日历天计算，避免夏令时误差） */
function dayDiff(a, b) {
  const da = parseKey(a), db = parseKey(b);
  return Math.round((db - da) / 86400000);
}
/** 把日期前后移动 n 天 */
function shiftDate(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
function weekdayOf(key) {
  const d = parseKey(key).getDay();            // 0 = 周日
  return '周' + WEEKDAYS[(d + 6) % 7];
}
/** 毫秒 → HH:MM:SS */
function fmtClock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
/** 秒 → 人类可读时长 */
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  if (m > 0) return `${m} 分钟`;
  return `${s} 秒`;
}
/** 秒 → 紧凑显示（用于图表/徽章） */
function fmtShort(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`;
}
/** 时间戳 → HH:MM */
function fmtHM(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 'YYYY-MM-DD' → '9月11日 周五' */
function fmtDateLabel(key) {
  const d = parseKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayOf(key)}`;
}

/* ==========================================================================
 *  3. 本地数据层（localStorage）
 * ========================================================================== */

function blankDB() {
  return { version: 1, users: {}, currentUser: null, active: {}, records: {}, settings: {} };
}

let DB = blankDB();
let storageAvailable = true;

function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    DB = raw ? JSON.parse(raw) : blankDB();
    // 简单校验，避免损坏的数据导致白屏
    if (typeof DB !== 'object' || DB === null) DB = blankDB();
  } catch (e) {
    DB = blankDB();
    storageAvailable = false;
  }
  DB.users = DB.users || {};
  DB.records = DB.records || {};
  DB.active = DB.active || {};
  DB.settings = DB.settings || {};
  Object.keys(DB.records).forEach((name) => normalizeRecords(DB.records[name]));
}

function saveDB() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
  } catch (e) {
    toast('本地数据写入失败：' + e.message, 'err');
  }
}

/* ---- 当前会话相关 ---- */

const currentUser = () => (DB.currentUser ? DB.users[DB.currentUser] : null);

function userRecords() {
  if (!DB.currentUser) return {};
  DB.records[DB.currentUser] = DB.records[DB.currentUser] || {};
  return DB.records[DB.currentUser];
}

function userSettings() {
  if (!DB.currentUser) return { goal: DEFAULT_GOAL };
  DB.settings[DB.currentUser] = DB.settings[DB.currentUser] || { goal: DEFAULT_GOAL };
  return DB.settings[DB.currentUser];
}

/** 当前账号正在进行的计时（跨刷新保留） */
function activeSession() {
  return DB.currentUser ? DB.active[DB.currentUser] || null : null;
}

/**
 * 规范化记录结构：兼容导入的备份文件或字段缺失的老数据，
 * 保证每条记录都有 segments 数组与 seconds 总时长。
 */
function normalizeRecords(recs) {
  Object.keys(recs || {}).forEach((k) => {
    const r = recs[k];
    if (!r || typeof r !== 'object') { delete recs[k]; return; }
    r.segments = (Array.isArray(r.segments) ? r.segments : [])
      .filter((s) => s && typeof s.start === 'number')
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end) || Number(s.start),
        seconds: Math.max(0, Number(s.seconds) || 0),
        note: typeof s.note === 'string' ? s.note : ''
      }));
    r.seconds = r.segments.length
      ? r.segments.reduce((sum, s) => sum + s.seconds, 0)
      : Math.max(0, Number(r.seconds) || 0);
    r.note = typeof r.note === 'string' ? r.note.slice(0, 200) : '';   // 当日备注
  });
  return recs;
}

/* ---- 密码散列 ---- */

function randomSalt() {
  if (window.crypto && crypto.getRandomValues) {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * 计算密码摘要。优先使用 WebCrypto 的 SHA-256；
 * 若浏览器处于非安全上下文（某些环境下 file:// 会禁用 crypto.subtle），
 * 则退回到一个简单的 FNV 混合散列，保证功能可用（仅用于本地演示，非生产级安全）。
 */
async function hashPassword(password, salt) {
  const bytes = new TextEncoder().encode(salt + '::' + password);
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* 落到兜底方案 */ }
  }
  let h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0;
  for (const b of bytes) {
    h1 = ((h1 ^ b) * 16777619) >>> 0;
    h2 = (h2 + b * 31) >>> 0;
  }
  return 'fnv-' + h1.toString(16) + h2.toString(16);
}

/* ==========================================================================
 *  4. 账号：注册 / 登录 / 退出
 * ========================================================================== */

async function registerUser({ username, nickname, password, avatar }) {
  if (DB.users[username]) throw new Error('该用户名已被占用，换一个试试');
  const salt = randomSalt();
  DB.users[username] = {
    username,
    nickname: nickname || username,
    avatar: avatar || AVATARS[0],
    salt,
    hash: await hashPassword(password, salt),
    createdAt: Date.now()
  };
  DB.currentUser = username;
  DB.records[username] = DB.records[username] || {};
  DB.settings[username] = { goal: DEFAULT_GOAL };
  saveDB();
}

async function loginUser(username, password) {
  const u = DB.users[username];
  if (!u) throw new Error('用户名不存在，请先注册');
  const hash = await hashPassword(password, u.salt);
  if (hash !== u.hash) throw new Error('密码不正确');
  DB.currentUser = username;
  saveDB();
}

function logoutUser() {
  DB.currentUser = null;
  saveDB();
  closeDropdown();
  renderAll();
  toast('已退出登录', 'ok');
}

/* ==========================================================================
 *  5. 统计计算
 * ========================================================================== */

function computeStats() {
  const recs = userRecords();
  const allKeys = Object.keys(recs).sort();

  // 关键：只有「真正有学习段」的日子才算打卡日。
  // 单纯给某天写备注（比如"今天请假"）不计入打卡天数，也不影响连续天数。
  const keys = allKeys.filter((k) => (recs[k].segments || []).length > 0);

  let totalSec = 0, maxDaySec = 0;
  keys.forEach((k) => {
    const s = recs[k].seconds || 0;
    totalSec += s;
    if (s > maxDaySec) maxDaySec = s;
  });

  // 历史最长连续
  let maxStreak = 0, run = 0, prev = null;
  keys.forEach((k) => {
    run = prev && dayDiff(prev, k) === 1 ? run + 1 : 1;
    if (run > maxStreak) maxStreak = run;
    prev = k;
  });

  // 当前连续：今天有记录就从今天往回数；今天还没打卡则从昨天往回数
  let streak = 0;
  let cursor = dateKey();
  if (!recs[cursor] || !(recs[cursor].segments || []).length) cursor = shiftDate(cursor, -1);
  while (recs[cursor] && (recs[cursor].segments || []).length) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  const activeDays = keys.length || 1;
  return {
    keys, allKeys, totalDays: keys.length, totalSec, maxDaySec,
    maxStreak, streak,
    todaySec: (recs[dateKey()] || {}).seconds || 0,
    avgSec: Math.round(totalSec / activeDays),
    checkedToday: !!(recs[dateKey()] && (recs[dateKey()].segments || []).length),
    noteDays: allKeys.filter((k) => (recs[k].note || '').trim()).length
  };
}

/* ==========================================================================
 *  6. 成就定义
 * ========================================================================== */

const ACHIEVEMENTS = [
  { id: 'first', emoji: '🌱', name: '启程', desc: '完成第一次学习打卡', target: 1, value: (s) => s.totalDays, unit: 'day' },
  { id: 'd7', emoji: '🏅', name: '七日坚持', desc: '连续打卡 7 天', target: 7, value: (s) => s.maxStreak, unit: 'day' },
  { id: 'd30', emoji: '🏆', name: '月度学者', desc: '连续打卡 30 天', target: 30, value: (s) => s.maxStreak, unit: 'day' },
  { id: 't10', emoji: '📅', name: '十日之约', desc: '累计打卡 10 天', target: 10, value: (s) => s.totalDays, unit: 'day' },
  { id: 't50', emoji: '🎓', name: '五十日', desc: '累计打卡 50 天', target: 50, value: (s) => s.totalDays, unit: 'day' },
  { id: 'h10', emoji: '⏳', name: '十小时', desc: '累计学习满 10 小时', target: 10 * 3600, value: (s) => s.totalSec, unit: 'sec' },
  { id: 'h50', emoji: '🔥', name: '五十小时', desc: '累计学习满 50 小时', target: 50 * 3600, value: (s) => s.totalSec, unit: 'sec' },
  { id: 'day4', emoji: '⚡', name: '专注一日', desc: '单日学习满 4 小时', target: 4 * 3600, value: (s) => s.maxDaySec, unit: 'sec' }
];

function achievementState(stats) {
  return ACHIEVEMENTS.map((a) => {
    const cur = a.value(stats);
    return {
      ...a, current: cur, unlocked: cur >= a.target,
      pct: Math.min(100, Math.round((cur / a.target) * 100)),
      meta: a.unit === 'sec' ? `${fmtShort(cur)} / ${fmtShort(a.target)}` : `${cur} / ${a.target} 天`
    };
  });
}

/* ==========================================================================
 *  7. 学习计时器（用户自己开始 / 结束）
 * ========================================================================== */

let tickHandle = null;

function startSession() {
  if (!currentUser()) { openAuth('login'); toast('请先登录再开始学习', 'warn'); return; }
  if (activeSession()) return;

  DB.active[DB.currentUser] = {
    start: Date.now(),
    note: ($('#sessionNote').value || '').trim()
  };
  saveDB();
  $('#sessionNote').value = '';
  toast('计时开始，专注学习吧！', 'ok');
  renderAll();
}

function stopSession() {
  const s = activeSession();
  if (!s) return;

  const end = Date.now();
  let seconds = Math.round((end - s.start) / 1000);

  // 保护：长时间未关闭计时器
  if (seconds > MAX_SESSION_HOURS * 3600) {
    const cut = confirm(
      `本次计时 ${(seconds / 3600).toFixed(1)} 小时，看起来像是忘记关闭计时器了。\n\n` +
      `点「确定」按 ${MAX_SESSION_HOURS} 小时记录；点「取消」按实际时长记录。`
    );
    if (cut) seconds = MAX_SESSION_HOURS * 3600;
  }
  if (seconds < 1) seconds = 1;

  // 归属日期按「开始学习」那天计算（跨午夜时更符合直觉）
  const key = dateKey(new Date(s.start));
  const recs = userRecords();
  recs[key] = recs[key] || { seconds: 0, segments: [], note: '' };
  recs[key].segments.push({
    start: s.start, end, seconds,
    note: s.note || ''
  });
  recs[key].seconds = recs[key].segments.reduce((sum, x) => sum + x.seconds, 0);

  delete DB.active[DB.currentUser];
  saveDB();

  toast(`本次学习 ${fmtDuration(seconds)}，已记入 ${fmtDateLabel(key)}`, 'ok');
  renderAll();
}

function discardSession() {
  if (!activeSession()) return;
  if (!confirm('确定放弃本次计时吗？这段时间不会被记录。')) return;
  delete DB.active[DB.currentUser];
  saveDB();
  toast('已放弃本次计时', 'warn');
  renderAll();
}

/** 每秒刷新计时显示与标签页标题 */
function tick() {
  const s = activeSession();
  const clock = $('#timerClock');
  const hint = $('#timerHint');
  if (!clock) return;

  if (s) {
    const ms = Date.now() - s.start;
    clock.textContent = fmtClock(ms);
    clock.classList.add('running');
    hint.textContent = `本次计时中 · 开始于 ${fmtHM(s.start)} · 今日已累计 ${fmtDuration(currentUser() ? computeStats().todaySec : 0)}`;
    document.title = `${fmtClock(ms)} · ${BASE_TITLE}`;
  } else {
    const st = currentUser() ? computeStats() : { todaySec: 0 };
    clock.textContent = fmtClock(st.todaySec * 1000);
    clock.classList.remove('running');
    hint.textContent = st.todaySec > 0
      ? '今日累计学习时长 · 点击「开始学习」继续'
      : '点击「开始学习」启动计时器';
    document.title = viewTitle();
  }
}

function ensureTick() {
  const running = !!activeSession();
  if (running && !tickHandle) tickHandle = setInterval(tick, 1000);
  if (!running && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  tick();
}

/* ==========================================================================
 *  7.5 备注：每段备注 + 当日备注（打卡日历 / 学习记录 两处均可编辑）
 * ========================================================================== */

/**
 * 备注编辑状态。同一时刻只会有一个输入框处于编辑态。
 *   target: 'seg'（某一段学习的备注） | 'day'（某天的当日备注）
 *   key:    日期 YYYY-MM-DD
 *   index:  段序号（仅 target === 'seg' 时有效）
 */
let noteEdit = { target: null, key: null, index: -1 };
let dayModalKey = null;      // 当前打开的「某天详情」弹窗对应的日期

const MAX_SEG_NOTE = 60;
const MAX_DAY_NOTE = 200;

const isEditingSeg = (key, i) => noteEdit.target === 'seg' && noteEdit.key === key && noteEdit.index === i;
const isEditingDay = (key) => noteEdit.target === 'day' && noteEdit.key === key;

/** 修改某一段学习的备注 */
function setSegmentNote(key, index, note) {
  const rec = userRecords()[key];
  if (!rec || !rec.segments[index]) { noteEdit = { target: null }; return; }
  rec.segments[index].note = String(note || '').trim().slice(0, MAX_SEG_NOTE);
  saveDB();
  toast(rec.segments[index].note ? '本段备注已保存' : '已清除本段备注', 'ok');
  noteEdit = { target: null };
  rerenderNotes();
}

/**
 * 设置某一天的「当日备注」。可以给**任何一天**写，包括没有学习记录的空白日
 * （例如补记"今天请假"）。注意：写备注不会让这天变成打卡日。
 */
function setDayNote(key, note) {
  const recs = userRecords();
  const text = String(note || '').trim().slice(0, MAX_DAY_NOTE);

  if (!text) {
    if (recs[key]) {
      recs[key].note = '';
      // 既没有学习段也没有备注的空记录直接删掉，避免留下垃圾数据
      if (!(recs[key].segments || []).length) delete recs[key];
    }
    toast('已清除当日备注', 'warn');
  } else {
    recs[key] = recs[key] || { seconds: 0, segments: [], note: '' };
    recs[key].note = text;
    toast('当日备注已保存', 'ok');
  }

  saveDB();
  noteEdit = { target: null };
  rerenderNotes();
}

/** 备注发生变化后，刷新所有展示备注的区域 */
function rerenderNotes() {
  if (!currentUser()) return;
  renderRecords();
  renderCalendar();
  renderDashboard();                       // 仪表盘今日卡片里也会列出各段备注
  if (dayModalKey) renderDayModal(dayModalKey);

  // 自动聚焦到刚出现的输入框（取第一个可见的）
  const inputs = $$('.note-input').filter((el) => el && el.offsetParent !== null);
  const box = inputs[0] || $$('.note-input')[0];
  if (box && box.focus) {
    box.focus();
    try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { /* 忽略 */ }
  }
}

/** 一段学习的 HTML（含「编辑备注」按钮） */
function segmentHTML(key, s, i) {
  const head = `
      <span class="seg-dur">#${i + 1}</span>
      <span class="seg-time">${fmtHM(s.start)} – ${fmtHM(s.end)}</span>
      <span class="seg-dur">${fmtDuration(s.seconds)}</span>`;

  if (isEditingSeg(key, i)) {
    return `<div class="seg editing" data-daykey="${key}">
        ${head}
        <input class="note-input seg-input" data-seg-input="${i}" maxlength="${MAX_SEG_NOTE}"
               placeholder="给这一段写点备注…" value="${esc(s.note || '')}" />
        <button class="btn btn-primary btn-sm" data-save-seg="${i}">保存</button>
        <button class="btn btn-ghost btn-sm" data-cancel-note="1">取消</button>
      </div>`;
  }

  return `<div class="seg" data-daykey="${key}">
      ${head}
      <span class="seg-note">${s.note ? esc(s.note) : '<span class="muted">无备注</span>'}</span>
      <button class="seg-edit" data-edit-seg="${i}" title="编辑本段备注" aria-label="编辑本段备注">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/>
        </svg>
      </button>
    </div>`;
}

/** 一段学习列表的 HTML */
function segmentsHTML(key, segments) {
  return `<div class="seg-list">${segments.map((s, i) => segmentHTML(key, s, i)).join('')}</div>`;
}

/** 「当日备注」区块的 HTML */
function dayNoteHTML(key) {
  const text = (userRecords()[key] || {}).note || '';

  if (isEditingDay(key)) {
    return `<div class="day-note editing" data-daykey="${key}">
        <div class="day-note-head">
          <span class="dn-title">📝 当日备注</span>
          <span class="spacer"></span>
          <span class="muted fs-12">${text.length}/${MAX_DAY_NOTE}</span>
        </div>
        <textarea class="note-input day-note-input" maxlength="${MAX_DAY_NOTE}"
                  placeholder="记点今天的心得、计划或状态…（也可以给没有学习的日子写，比如「今天请假」）">${esc(text)}</textarea>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" data-save-daynote="1">保存</button>
          ${text ? '<button class="btn btn-danger-ghost btn-sm" data-clear-daynote="1">清除</button>' : ''}
          <button class="btn btn-ghost btn-sm" data-cancel-note="1">取消</button>
        </div>
      </div>`;
  }

  return `<div class="day-note" data-daykey="${key}">
      <div class="day-note-head">
        <span class="dn-title">📝 当日备注</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" data-edit-daynote="1">
          ${text ? '编辑' : '添加备注'}
        </button>
      </div>
      ${text
        ? `<p class="day-note-body">${esc(text)}</p>`
        : '<p class="day-note-body muted">还没有备注，点右侧按钮写点什么吧。</p>'}
    </div>`;
}

/* ==========================================================================
 *  8. 渲染：顶部导航与右上角用户区
 * ========================================================================== */

function renderAuthArea() {
  const area = $('#authArea');
  const u = currentUser();

  if (!u) {
    area.innerHTML = `<button class="btn btn-primary" data-open-auth="login">登录</button>`;
    return;
  }

  area.innerHTML = `
    <div class="user-menu" id="userMenu">
      <button class="user-btn" id="userBtn" aria-haspopup="true" aria-expanded="false">
        <span class="avatar">${esc(u.avatar)}</span>
        <span class="u-name">${esc(u.nickname || u.username)}</span>
        <svg class="caret" viewBox="0 0 24 24" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      <div class="dropdown" id="userDropdown" hidden>
        <div class="dropdown-head">
          <span class="avatar lg">${esc(u.avatar)}</span>
          <div>
            <div class="u-full">${esc(u.nickname || u.username)}</div>
            <div class="u-sub">@${esc(u.username)} · 注册于 ${new Date(u.createdAt).toLocaleDateString('zh-CN')}</div>
          </div>
        </div>
        <button class="dropdown-item" data-go="dashboard">📊 仪表盘</button>
        <button class="dropdown-item" data-go="records">📄 我的学习记录</button>
        <button class="dropdown-item" data-go="settings">⚙️ 个人设置</button>
        <div class="dropdown-sep"></div>
        <button class="dropdown-item danger" id="btnLogout">↩ 退出登录</button>
      </div>
    </div>`;

  $('#userBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('#userDropdown');
    const open = dd.hidden;
    dd.hidden = !open;
    $('#userMenu').classList.toggle('open', open);
    $('#userBtn').setAttribute('aria-expanded', String(open));
  });

  $('#userDropdown').addEventListener('click', (e) => e.stopPropagation());
  $('#btnLogout').addEventListener('click', logoutUser);
  $$('#userDropdown [data-go]').forEach((b) => {
    b.addEventListener('click', () => { closeDropdown(); location.hash = '#/' + b.dataset.go; });
  });
}

function closeDropdown() {
  const dd = $('#userDropdown');
  if (dd) dd.hidden = true;
  const menu = $('#userMenu');
  if (menu) menu.classList.remove('open');
}

/* ==========================================================================
 *  9. 渲染：路由与视图切换
 * ========================================================================== */

function currentView() {
  const v = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(v) ? v : 'dashboard';
}

/** 当前应该在浏览器标签上显示的标题（计时中会被覆盖为倒计时/正计时） */
function viewTitle() {
  return currentUser() ? `${VIEW_TITLES[currentView()]} · ${BASE_TITLE}` : BASE_TITLE;
}

function renderRoute() {
  const view = currentView();
  const logged = !!currentUser();

  // 导航高亮（顶部导航 + 移动端底部标签栏）
  $$('[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));

  // 视图显隐
  $$('[data-view-panel]').forEach((p) => {
    p.hidden = !(logged && p.dataset.viewPanel === view);
  });
  $('#guestView').hidden = !(!logged && view === 'dashboard');
  $('#gateView').hidden = !(!logged && view !== 'dashboard');

  document.title = viewTitle();
}

/* ==========================================================================
 * 10. 渲染：仪表盘
 * ========================================================================== */

function renderDashboard() {
  const u = currentUser();
  if (!u) return;

  const st = computeStats();
  const goal = Number(userSettings().goal) || DEFAULT_GOAL;
  const running = !!activeSession();

  // 问候语随时间变化
  const h = new Date().getHours();
  const greet = h < 6 ? '夜深了，注意休息' : h < 11 ? '早上好，新的一天从专注开始'
    : h < 14 ? '中午好，别忘了午休' : h < 18 ? '下午好，继续保持'
    : h < 23 ? '晚上好，今天的学习目标完成了吗' : '夜深了，早点休息';
  $('#dashGreeting').textContent = `${greet}，${u.nickname || u.username}`;
  const now = new Date();
  $('#dashDate').textContent =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekdayOf(dateKey(now))}`;

  // 今日状态徽章
  const badge = $('#todayBadge');
  if (running) {
    badge.className = 'pill live';
    badge.textContent = '计时中';
  } else if (st.checkedToday) {
    badge.className = 'pill ok';
    badge.textContent = '今日已打卡';
  } else {
    badge.className = 'pill warn';
    badge.textContent = '今日未打卡';
  }

  // 按钮状态
  $('#btnStart').hidden = running;
  $('#btnStop').hidden = !running;
  $('#btnCancelSession').hidden = !running;
  $('#sessionNote').disabled = running;

  // 今日汇总
  const todayRec = userRecords()[dateKey()] || { seconds: 0, segments: [] };
  const pct = Math.min(100, Math.round((st.todaySec / (goal * 60)) * 100));
  $('#todayMeta').innerHTML = `
    <div class="row"><span>今日累计</span><span><b>${fmtDuration(st.todaySec)}</b></span></div>
    <div class="row"><span>学习段数</span><span>${todayRec.segments.length} 段</span></div>
    <div class="row"><span>今日目标</span><span>${goal} 分钟（已完成 ${pct}%）</span></div>
    ${todayRec.segments.length
      ? `<div class="seg-list">${todayRec.segments.map((s, i) => `
          <div class="seg">
            <span class="seg-dur">#${i + 1}</span>
            <span class="seg-time">${fmtHM(s.start)} – ${fmtHM(s.end)}</span>
            <span class="seg-dur">${fmtDuration(s.seconds)}</span>
            <span class="seg-note">${s.note ? esc(s.note) : '<span class="muted">无备注</span>'}</span>
          </div>`).join('')}</div>`
      : '<p class="muted fs-12" style="margin-top:10px">今天还没有学习记录，点上面的按钮开始吧。</p>'}`;

  // 目标进度环
  $('#ringValue').style.strokeDashoffset = String(RING_C * (1 - pct / 100));
  $('#ringPct').textContent = pct + '%';
  $('#ringGoalNum').textContent = goal;
  $('#ringFoot').textContent = st.todaySec >= goal * 60
    ? '🎉 今日目标已达成，非常棒！'
    : `还差 ${fmtDuration(goal * 60 - st.todaySec)} 达成今日目标`;

  // 统计卡
  $('#statTotalDays').textContent = st.totalDays;
  $('#statStreak').textContent = st.streak;
  $('#statMaxStreak').textContent = st.maxStreak;
  $('#statTotalTime').textContent = st.totalSec >= 3600
    ? `${Math.floor(st.totalSec / 3600)} 小时 ${Math.floor((st.totalSec % 3600) / 60)} 分`
    : `${Math.floor(st.totalSec / 60)} 分钟`;

  renderWeekChart(st);
  renderAchPreview(st);
}

function renderWeekChart() {
  const recs = userRecords();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = shiftDate(dateKey(), -i);
    const sec = (recs[key] || {}).seconds || 0;
    days.push({ key, sec, label: weekdayOf(key).slice(1) });
  }
  const max = Math.max(...days.map((d) => d.sec), 1);
  const total = days.reduce((s, d) => s + d.sec, 0);
  $('#weekTotal').textContent = `共 ${fmtDuration(total)}`;

  $('#weekChart').innerHTML = days.map((d) => `
    <div class="wk-col" title="${fmtDateLabel(d.key)}：${fmtDuration(d.sec)}">
      <span class="wk-label muted" style="font-size:10.5px">${d.sec ? fmtShort(d.sec) : '–'}</span>
      <div class="wk-bar-wrap">
        <div class="wk-bar ${d.sec ? '' : 'zero'}" style="height:${d.sec ? Math.max(8, (d.sec / max) * 100) : 4}%"></div>
      </div>
      <span class="wk-label"><b>${d.label}</b></span>
    </div>`).join('');
}

function renderAchPreview() {
  const list = achievementState(computeStats());
  const show = list.filter((a) => a.unlocked).slice(0, 2);
  const fill = list.filter((a) => !a.unlocked)
    .sort((a, b) => b.pct - a.pct).slice(0, 4 - show.length);
  const combined = [...show, ...fill].slice(0, 4);

  $('#achPreview').innerHTML = combined.map((a) => `
    <div class="ach-mini-row ${a.unlocked ? 'on' : ''}">
      <span class="e">${a.emoji}</span>
      <div style="flex:1">
        <div class="n">${a.name}</div>
        <div class="p">${a.unlocked ? '已解锁 🎉' : a.meta}</div>
      </div>
    </div>`).join('') + `
    <p class="muted fs-12" style="text-align:center">
      已解锁 ${list.filter((a) => a.unlocked).length} / ${list.length} 个成就
    </p>`;
}

/* ==========================================================================
 * 11. 渲染：打卡日历
 * ========================================================================== */

let calCursor = new Date();

function renderCalendar() {
  if (!currentUser()) return;
  const recs = userRecords();
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();

  $('#calTitle').textContent = `${y} 年 ${m + 1} 月`;

  const firstWeekday = (new Date(y, m, 1).getDay() + 6) % 7;   // 周一为一周起点
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayKey = dateKey();

  let html = '';
  for (let i = 0; i < firstWeekday; i++) html += '<div class="cal-day empty"></div>';

  let monthSec = 0, monthDays = 0, monthNotes = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(new Date(y, m, d));
    const rec = recs[key] || {};
    const sec = rec.seconds || 0;
    const hasStudy = (rec.segments || []).length > 0;
    const hasNote = !!(rec.note || '').trim();
    if (hasStudy) { monthSec += sec; monthDays += 1; }
    if (hasNote) monthNotes += 1;

    // 颜色档位只按学习时长，备注不影响
    const level = !hasStudy ? 0 : sec < 1800 ? 1 : sec < 5400 ? 2 : 3;
    // 只有备注没有学习的日子，用浅色底 + 备注角标区分出来
    const noteOnly = !hasStudy && hasNote ? ' note-only' : '';

    html += `<div class="cal-day lv${level}${noteOnly} ${key === todayKey ? 'today' : ''}" data-day="${key}"
                  title="${fmtDateLabel(key)}${hasStudy ? '：' + fmtDuration(sec) : '：未学习'}${hasNote ? '　📝 ' + esc(rec.note) : ''}">
               <span>${d}</span>
               ${hasStudy ? `<span class="m">${fmtShort(sec)}</span>` : ''}
               ${hasNote ? '<i class="note-flag" aria-label="有备注"></i>' : ''}
             </div>`;
  }

  $('#calGrid').innerHTML = html;
  $$('#calGrid .cal-day[data-day]').forEach((el) => {
    el.addEventListener('click', () => openDay(el.dataset.day));
  });

  // 本月小结
  const st = computeStats();
  $('#calSummary').innerHTML = `
    <span>本月打卡 <b>${monthDays}</b> 天</span>
    <span>本月学习 <b>${fmtDuration(monthSec)}</b></span>
    <span>本月备注 <b>${monthNotes}</b> 条</span>
    <span>当前连续 <b>${st.streak}</b> 天</span>
    <span>历史最长 <b>${st.maxStreak}</b> 天</span>`;
}

function openDay(key) {
  dayModalKey = key;
  renderDayModal(key);
  $('#dayModal').hidden = false;
}

/** 渲染「某天详情」弹窗内容（按天来看备注的主要入口） */
function renderDayModal(key) {
  const rec = userRecords()[key];
  const isToday = key === dateKey();
  const segments = (rec && rec.segments) || [];

  $('#dayTitle').textContent = fmtDateLabel(key) + (isToday ? '（今天）' : '');

  if (!segments.length) {
    $('#daySubtitle').textContent = '这一天没有学习记录';
    $('#dayBody').innerHTML =
      '<div class="empty-state" style="padding:24px 0"><span class="big">🌙</span>休息也是学习的一部分</div>'
      + dayNoteHTML(key);
  } else {
    $('#daySubtitle').textContent =
      `共 ${segments.length} 段 · 累计 ${fmtDuration(rec.seconds)}`;
    $('#dayBody').innerHTML = segmentsHTML(key, segments) + dayNoteHTML(key);
  }
}

/* ==========================================================================
 * 12. 渲染：学习记录
 * ========================================================================== */

function renderRecords() {
  if (!currentUser()) return;
  const recs = userRecords();
  const allKeys = Object.keys(recs).sort().reverse();
  // 有学习段、或有当日备注的日子都展示出来（纯备注的日子也会列出）
  const keys = allKeys.filter((k) =>
    (recs[k].segments || []).length > 0 || (recs[k].note || '').trim());
  const box = $('#recordsList');

  if (!keys.length) {
    box.innerHTML = `<div class="card"><div class="empty-state">
        <span class="big">📄</span>还没有学习记录，去仪表盘点「开始学习」吧
      </div></div>`;
    return;
  }

  box.innerHTML = keys.map((key) => {
    const rec = recs[key];
    const segments = rec.segments || [];
    const total = segments.length
      ? `${segments.length} 段 · 累计 <b>${fmtDuration(rec.seconds)}</b>`
      : '<span class="muted">仅备注，未学习</span>';

    return `
      <div class="rec-day">
        <div class="rec-day-head">
          <span class="rec-date">${fmtDateLabel(key)}</span>
          <span class="rec-weekday">${key}</span>
          <span class="spacer"></span>
          <span class="rec-total">${total}</span>
        </div>
        ${segments.length ? `<div class="rec-segs">${segmentsHTML(key, segments)}</div>` : ''}
        ${dayNoteHTML(key)}
      </div>`;
  }).join('');
}

/* ==========================================================================
 * 13. 渲染：成就墙
 * ========================================================================== */

function renderAchievements() {
  if (!currentUser()) return;
  const list = achievementState(computeStats());
  const unlocked = list.filter((a) => a.unlocked).length;

  $('#achSummary').textContent = `已解锁 ${unlocked} / ${list.length} 个成就 · 继续坚持就会有更多徽章点亮`;

  $('#achGrid').innerHTML = list.map((a) => `
    <div class="ach-card ${a.unlocked ? 'unlocked' : ''}">
      <span class="ach-emoji">${a.emoji}</span>
      <div class="ach-name">${a.name}</div>
      <div class="ach-desc">${a.desc}</div>
      <div class="ach-progress"><i style="width:${a.pct}%"></i></div>
      <div class="ach-meta">
        <span>${a.unlocked ? '已解锁 🎉' : '进行中'}</span>
        <span>${a.meta}</span>
      </div>
    </div>`).join('');
}

/* ==========================================================================
 * 14. 渲染：设置
 * ========================================================================== */

let regAvatar = AVATARS[0];       // 注册弹窗里选中的头像
let profileAvatar = AVATARS[0];   // 设置页里选中的头像

/**
 * 渲染头像选择器
 * @param containerId 容器 id
 * @param selected    当前选中的头像
 * @param onPick      点击后的回调（不同场景各存各的状态，避免互相覆盖）
 */
function renderAvatarPicker(containerId, selected, onPick) {
  const box = $('#' + containerId);
  if (!box) return;
  box.innerHTML = AVATARS.map((a) =>
    `<button type="button" class="avatar-opt ${a === selected ? 'active' : ''}" data-avatar="${a}">${a}</button>`
  ).join('');
  $$(`#${containerId} .avatar-opt`).forEach((b) => {
    b.addEventListener('click', () => {
      $$(`#${containerId} .avatar-opt`).forEach((x) => x.classList.toggle('active', x === b));
      onPick(b.dataset.avatar);
    });
  });
}

function renderSettings() {
  const u = currentUser();
  if (!u) return;

  $('#inpNickname').value = u.nickname || u.username;
  $('#inpUsername').value = u.username;
  $('#inpGoal').value = Number(userSettings().goal) || DEFAULT_GOAL;
  profileAvatar = u.avatar;
  renderAvatarPicker('avatarPicker', profileAvatar, (a) => { profileAvatar = a; });
}

/* ==========================================================================
 * 15. 弹窗：登录 / 注册
 * ========================================================================== */

function openAuth(tab = 'login') {
  switchAuthTab(tab);
  $('#loginError').textContent = '';
  $('#regError').textContent = '';
  $('#authModal').hidden = false;
  setTimeout(() => {
    (tab === 'login' ? $('#loginUser') : $('#regUser')).focus();
  }, 60);
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  $$('#authTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#formLogin').hidden = !isLogin;
  $('#formRegister').hidden = isLogin;
  $('#authTitle').textContent = isLogin ? '欢迎回来' : '创建账号';
  $('#authSubtitle').textContent = isLogin
    ? '登录后即可继续记录你的学习'
    : '账号只保存在本机浏览器，密码以摘要形式存储';
}

async function submitLogin(e) {
  e.preventDefault();
  const err = $('#loginError');
  err.textContent = '';
  const username = $('#loginUser').value.trim();
  const password = $('#loginPwd').value;

  if (!username || !password) { err.textContent = '请填写用户名和密码'; return; }
  try {
    await loginUser(username, password);
    $('#loginPwd').value = '';
    $('#authModal').hidden = true;
    toast(`欢迎回来，${DB.users[username].nickname || username}！`, 'ok');
    renderAll();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

async function submitRegister(e) {
  e.preventDefault();
  const err = $('#regError');
  err.textContent = '';
  const username = $('#regUser').value.trim();
  const nickname = $('#regNick').value.trim();
  const pwd = $('#regPwd').value;
  const pwd2 = $('#regPwd2').value;

  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    err.textContent = '用户名需为 3-16 位字母、数字或下划线'; return;
  }
  if (pwd.length < 6) { err.textContent = '密码至少 6 位'; return; }
  if (pwd !== pwd2) { err.textContent = '两次输入的密码不一致'; return; }

  try {
    await registerUser({ username, nickname: nickname || username, password: pwd, avatar: regAvatar });
    $('#formRegister').reset();
    regAvatar = AVATARS[0];
    renderAvatarPicker('regAvatarPicker', regAvatar, (a) => { regAvatar = a; });
    $('#authModal').hidden = true;
    toast('账号创建成功，开始你的第一次学习吧！', 'ok');
    location.hash = '#/dashboard';
    renderAll();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

/* ==========================================================================
 * 16. 设置页操作
 * ========================================================================== */

function saveProfile() {
  const u = currentUser();
  if (!u) return;
  const nick = $('#inpNickname').value.trim();
  if (!nick) { toast('昵称不能为空', 'warn'); return; }
  u.nickname = nick;
  u.avatar = profileAvatar;
  saveDB();
  renderAll();
  toast('个人资料已保存', 'ok');
}

function saveGoal() {
  const v = Number($('#inpGoal').value);
  if (!v || v < 5 || v > 720) { toast('目标请填写 5 – 720 分钟之间', 'warn'); return; }
  userSettings().goal = Math.round(v);
  saveDB();
  renderAll();
  toast('每日目标已更新为 ' + Math.round(v) + ' 分钟', 'ok');
}

async function changePassword() {
  const u = currentUser();
  if (!u) return;
  const oldPwd = $('#inpOldPwd').value;
  const newPwd = $('#inpNewPwd').value;

  if (!oldPwd || !newPwd) { toast('请填写当前密码与新密码', 'warn'); return; }
  if (newPwd.length < 6) { toast('新密码至少 6 位', 'warn'); return; }

  const oldHash = await hashPassword(oldPwd, u.salt);
  if (oldHash !== u.hash) { toast('当前密码不正确', 'err'); return; }

  u.salt = randomSalt();
  u.hash = await hashPassword(newPwd, u.salt);
  saveDB();
  $('#inpOldPwd').value = '';
  $('#inpNewPwd').value = '';
  toast('密码已更新，请牢记新密码', 'ok');
}

function exportData() {
  const u = currentUser();
  if (!u) return;
  const payload = {
    app: 'StudyTrack',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: { username: u.username, nickname: u.nickname, avatar: u.avatar, createdAt: u.createdAt },
    settings: userSettings(),
    records: userRecords()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `studytrack-${u.username}-${dateKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('备份文件已开始下载', 'ok');
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object' || !data.records) {
        throw new Error('文件格式不正确');
      }
      if (!confirm('导入将用备份中的数据覆盖当前账号的学习记录，确定继续吗？')) return;

      const recs = userRecords();
      Object.keys(recs).forEach((k) => delete recs[k]);
      normalizeRecords(data.records);
      Object.keys(data.records).forEach((k) => { recs[k] = data.records[k]; });

      if (data.settings && data.settings.goal) userSettings().goal = Number(data.settings.goal);
      saveDB();
      renderAll();
      toast('导入完成，共恢复 ' + Object.keys(data.records).length + ' 天的记录', 'ok');
    } catch (e) {
      toast('导入失败：' + e.message, 'err');
    }
  };
  reader.readAsText(file);
}

function resetMyData() {
  const u = currentUser();
  if (!u) return;
  const first = confirm(
    `确定要清空账号「${u.username}」的所有学习记录吗？\n\n` +
    `删除后无法恢复，建议先导出备份。`
  );
  if (!first) return;
  if (!confirm('再次确认：这是不可撤销的操作，真的要清空吗？')) return;

  DB.records[u.username] = {};
  delete DB.active[u.username];
  saveDB();
  renderAll();
  toast('学习记录已清空', 'warn');
}

/* ==========================================================================
 * 17. 总渲染与事件绑定
 * ========================================================================== */

function renderAll() {
  renderAuthArea();
  renderRoute();
  if (currentUser()) {
    renderDashboard();
    renderCalendar();
    renderRecords();
    renderAchievements();
    renderSettings();
  }
  ensureTick();
}

function bindEvents() {
  /* 视图切换（哈希路由） */
  window.addEventListener('hashchange', () => {
    renderRoute();
    if (currentUser()) ensureTick();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* 登录入口（首页 hero、门禁卡片、右上角按钮） */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open-auth]');
    if (t) { openAuth(t.dataset.openAuth); return; }
    const jump = e.target.closest('[data-tab-jump]');
    if (jump) { e.preventDefault(); switchAuthTab(jump.dataset.tabJump); return; }
    // 点击空白处关闭用户下拉菜单
    if (!e.target.closest('.user-menu')) closeDropdown();
  });

  /* ---- 备注编辑（事件委托：因为记录列表与弹窗会整体重渲染） ---- */
  document.addEventListener('click', (e) => {
    const host = e.target.closest ? e.target.closest('[data-daykey]') : null;
    const keyOf = () => (host ? host.dataset.daykey : dayModalKey);

    // 编辑某一段的备注
    const editSeg = e.target.closest('[data-edit-seg]');
    if (editSeg) {
      noteEdit = { target: 'seg', key: keyOf(), index: Number(editSeg.dataset.editSeg) };
      rerenderNotes();
      return;
    }
    // 编辑当日备注
    if (e.target.closest('[data-edit-daynote]')) {
      noteEdit = { target: 'day', key: keyOf() };
      rerenderNotes();
      return;
    }
    // 保存某段备注
    const saveSeg = e.target.closest('[data-save-seg]');
    if (saveSeg) {
      const inp = host ? host.querySelector('.seg-input') : null;
      setSegmentNote(keyOf(), Number(saveSeg.dataset.saveSeg), inp ? inp.value : '');
      return;
    }
    // 保存当日备注
    if (e.target.closest('[data-save-daynote]')) {
      const inp = host ? host.querySelector('.day-note-input') : null;
      setDayNote(keyOf(), inp ? inp.value : '');
      return;
    }
    // 清除当日备注
    if (e.target.closest('[data-clear-daynote]')) {
      if (!confirm('确定清除这一天的备注吗？')) return;
      setDayNote(keyOf(), '');
      return;
    }
    // 取消编辑
    if (e.target.closest('[data-cancel-note]')) {
      noteEdit = { target: null };
      rerenderNotes();
    }
  });

  /* 备注输入框：Enter 保存、Esc 取消 */
  document.addEventListener('keydown', (e) => {
    if (!e.target || !e.target.classList || !e.target.classList.contains('note-input')) return;
    if (e.key === 'Escape') {
      noteEdit = { target: null };
      rerenderNotes();
      return;
    }
    const isDayInput = e.target.classList.contains('day-note-input');
    if (e.key === 'Enter' && (isDayInput ? (e.ctrlKey || e.metaKey) : true)) {
      e.preventDefault();
      const host = e.target.closest ? e.target.closest('[data-daykey]') : null;
      const key = host ? host.dataset.daykey : dayModalKey;
      if (isDayInput) setDayNote(key, e.target.value);
      else setSegmentNote(key, Number(e.target.dataset.segInput), e.target.value);
    }
  });

  /* 弹窗开关 */
  $('#authClose').addEventListener('click', () => { $('#authModal').hidden = true; });
  $('#dayClose').addEventListener('click', () => {
    $('#dayModal').hidden = true;
    dayModalKey = null;
    noteEdit = { target: null };
  });
  $$('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', (e) => {
      if (e.target !== mask) return;
      mask.hidden = true;
      if (mask === $('#dayModal')) { dayModalKey = null; noteEdit = { target: null }; }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#authModal').hidden = true;
      $('#dayModal').hidden = true;
      dayModalKey = null;
      noteEdit = { target: null };
      closeDropdown();
    }
  });

  /* 登录 / 注册表单 */
  $$('#authTabs .tab').forEach((t) => {
    t.addEventListener('click', () => switchAuthTab(t.dataset.tab));
  });
  $('#formLogin').addEventListener('submit', submitLogin);
  $('#formRegister').addEventListener('submit', submitRegister);
  renderAvatarPicker('regAvatarPicker', regAvatar, (a) => { regAvatar = a; });

  /* 学习计时 */
  $('#btnStart').addEventListener('click', startSession);
  $('#btnStop').addEventListener('click', stopSession);
  $('#btnCancelSession').addEventListener('click', discardSession);

  /* 日历翻月 */
  $('#btnPrevMonth').addEventListener('click', () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#btnNextMonth').addEventListener('click', () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  $('#btnThisMonth').addEventListener('click', () => {
    const now = new Date();
    calCursor = new Date(now.getFullYear(), now.getMonth(), 1);
    renderCalendar();
  });

  /* 设置页 */
  $('#btnSaveProfile').addEventListener('click', saveProfile);
  $('#btnSaveGoal').addEventListener('click', saveGoal);
  $('#btnChangePwd').addEventListener('click', changePassword);
  $('#btnExport').addEventListener('click', exportData);
  $('#btnExportInline').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', (e) => {
    importData(e.target.files[0]);
    e.target.value = '';
  });
  $('#btnResetData').addEventListener('click', resetMyData);

  /* 页面卸载前保存（保险起见） */
  window.addEventListener('beforeunload', saveDB);

  /* 跨标签页同步：另一个标签页改了数据，这里也跟着刷新 */
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    loadDB();
    renderAll();
  });
}

function init() {
  try {
    loadDB();

    if (!storageAvailable) {
      toast('当前浏览器不可用本地存储，数据将无法保存', 'err', 6000);
    }

    bindEvents();

    if (!location.hash) location.hash = '#/dashboard';
    renderAll();

    if (currentUser() && activeSession()) {
      toast('检测到上次的计时仍在进行中，已为你继续计时', 'info', 4200);
    }

    // 启动成功的标记，供 index.html 底部的「资源自检」脚本读取
    window.__STUDYTRACK_READY__ = true;
  } catch (err) {
    window.__STUDYTRACK_ERROR__ = (err && err.message) ? err.message : String(err);
    throw err;   // 仍然抛出，方便在控制台看到完整堆栈
  }
}

/**
 * 兼容不同的加载方式：
 *   · 正常情况下本文件通过 <script src="app.js"></script> 放在 </body> 之前，
 *     此时 readyState 仍是 'loading'，等 DOMContentLoaded 再初始化；
 *   · 如果被改成 defer / 异步注入 / 或放在 <head> 里，
 *     DOMContentLoaded 可能已经触发过，那种情况下直接初始化，避免页面永远不启动。
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
