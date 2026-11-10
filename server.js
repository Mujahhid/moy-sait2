// Сервер сайта bio_capybara: раздаёт страницы, принимает заявки, отдаёт их в админ-панель.
// Без внешних зависимостей. Настройки — только через переменные окружения:
//   PORT            — порт (Railway задаёт сам)
//   ADMIN_PASSWORD  — пароль от /admin (обязателен, иначе админка закрыта)
//   DATA_DIR        — папка для заявок (на Railway — путь подключённого диска)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const RECORDS_FILE = path.join(DATA_DIR, 'crm.json'); // записи CRM: одна запись = одна семья
const TRASH_FILE = path.join(DATA_DIR, 'crm-deleted.json'); // корзина: удалённые из CRM записи
const ROOT = __dirname;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- хранилище заявок (JSON-файл, запись через временный файл) ----------
let leads = [];
try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); if (!Array.isArray(leads)) leads = []; } catch { leads = []; }
// записи CRM (подробности формата — в инструкции к CRM)
let records = [];
try { records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8')); if (!Array.isArray(records)) records = []; } catch { records = []; }
let saving = Promise.resolve();
function writeAtomic(file, data) {
  const snapshot = JSON.stringify(data, null, 1);
  saving = saving.then(() => new Promise((resolve) => {
    const tmp = file + '.tmp';
    fs.writeFile(tmp, snapshot, (e) => {
      if (e) { console.error('save failed', e); return resolve(); }
      fs.rename(tmp, file, (e2) => { if (e2) console.error('rename failed', e2); resolve(); });
    });
  }));
  return saving;
}
const save = () => writeAtomic(LEADS_FILE, leads);
const saveRecords = () => writeAtomic(RECORDS_FILE, records);

// ---------- защита от спама: не больше 5 заявок с одного адреса за 10 минут ----------
const hits = new Map();
function rateLimited(ip, limit = 5) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 600000).unref();

// ---------- проверка пароля админа (сравнение без утечки по времени) ----------
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const h = req.headers['authorization'] || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- утилиты ----------
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
};
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...SEC, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 40000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// результаты тестов, которые посетитель прошёл на сайте (приходят вместе с заявкой)
function cleanResults(list) {
  if (!Array.isArray(list)) return [];
  const num = (v) => (Number.isFinite(v) && v >= 0 && v <= 1000 ? Math.round(v) : null);
  return list.slice(0, 30).map((r) => ({
    test: clip(r && r.test, 80),
    score: num(r && r.score),
    max: num(r && r.max),
    label: clip(r && r.label, 80),
    wrong: Array.isArray(r && r.wrong) ? r.wrong.slice(0, 40).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100) : [],
    at: (r && typeof r.at === 'string' && !isNaN(Date.parse(r.at))) ? new Date(r.at).toISOString() : null,
  })).filter((r) => r.test);
}

// ---------- CRM: записи семей ----------
// stage двигается с сайта только вперёд; shared и parent_opened этап не меняют, только пишутся в events
const SITE_ORDER = ['test_done', 'clicked_signup', 'claimed', 'paid', 'scheduled', 'diag_done', 'bought'];
const ALL_STAGES = [...SITE_ORDER, 'shared', 'parent_opened', 'lost'];
const TRACK_EVENTS = ['test_done', 'shared', 'parent_opened', 'clicked_signup', 'claimed', 'trainer'];
const ID_RE = /^[\w-]{4,16}$/;
const KINDS = ['probnik', 'risk', 'specialty', 'format', 'trainer'];
const ZONES = ['green', 'yellow', 'red'];
const PRICES = { 'Ислам': [2000, 2500], 'Абу-Бакр': [1250, 1500] }; // диагностика: Ислам 2 500 / 2 000, Абу-Бакр 1 500 / 1 250 (со скидкой за тест)
const nowIso = () => new Date().toISOString();
const numOrNull = (v, max = 100000) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 100) / 100 : null);
function cleanTest(t) {
  if (!t || typeof t !== 'object' || !clip(t.test, 80)) return null;
  const out = {
    at: (typeof t.at === 'string' && !isNaN(Date.parse(t.at))) ? new Date(t.at).toISOString() : nowIso(),
    test: clip(t.test, 80),
    kind: KINDS.includes(t.kind) ? t.kind : 'trainer',
    score: numOrNull(t.score, 1000), max: numOrNull(t.max, 1000),
    zone: ZONES.includes(t.zone) ? t.zone : null,
    label: clip(t.label, 100),
    answers: Array.isArray(t.answers) ? t.answers.slice(0, 60).map((a) => {
      const o = { n: numOrNull(a && a.n, 999) ?? clip(a && a.n, 10), q: clip(a && a.q, 220), a: clip(a && a.a, 200) };
      if (a && a.right != null && a.right !== '') o.right = clip(a.right, 200);
      if (a && numOrNull(a.pts, 100) != null) o.pts = numOrNull(a.pts, 100);
      if (a && numOrNull(a.max, 100) != null) o.max = numOrNull(a.max, 100);
      return o;
    }) : [],
    wrong: Array.isArray(t.wrong) ? t.wrong.slice(0, 60).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100) : [],
    risks: Array.isArray(t.risks) ? t.risks.slice(0, 10).map((x) => clip(x, 300)) : [],
    topics: Array.isArray(t.topics) ? t.topics.slice(0, 12).map((x) => ({ name: clip(x && x.name, 60), lost: numOrNull(x && x.lost, 1000) || 0, max: numOrNull(x && x.max, 1000) || 0 })).filter((x) => x.name) : [],
    extra: clip(t.extra, 300),
  };
  // нужное только странице родителя (CRM эти поля не использует)
  if (numOrNull(t.pos, 100) != null) out.pos = numOrNull(t.pos, 100);
  if (Array.isArray(t.shown)) out.shown = t.shown.slice(0, 6).map((x) => clip(x, 80));
  if (Array.isArray(t.errTopics)) out.errTopics = t.errTopics.slice(0, 12).map((x) => ({ name: clip(x && x.name, 60), err: numOrNull(x && x.err, 100) || 0, of: numOrNull(x && x.of, 100) || 0 })).filter((x) => x.name);
  return out;
}
function pushEvent(rec, type, extra) {
  rec.events = rec.events || [];
  if (type !== 'test_done' && rec.events.some((e) => e.type === type)) return false; // каждое событие воронки пишем один раз
  rec.events.push({ at: nowIso(), type, ...(extra || {}) });
  return true;
}
function newRecord(id) {
  return { id, created_at: nowIso(), role: 'student', exam: '', grade: '', goal: '', source: {}, contact: {}, tests: [], payment: {}, events: [], stage: 'test_done',
    diagnostic: { price: null, teacher: 'Ислам', scheduled_at: null, done_at: null, notes: '', recommended_tariff: '' },
    sale: { tariff: '', plan: 'month', amount: null, credited: 'no' }, notes: [], lost_reason: '' };
}
function applyTrack(d) {
  const id = clip(d.id, 16);
  if (!ID_RE.test(id) || !TRACK_EVENTS.includes(d.event)) return { code: 400, body: { error: 'invalid' } };
  let rec = records.find((r) => r.id === id);
  if (d.event === 'claimed') {
    const c = d.contact || {};
    if (c.consent !== true) return { code: 400, body: { error: 'consent_required' } };
    if (!/^\+7\d{10}$/.test(clip(c.phone, 20).replace(/[^\d+]/g, ''))) return { code: 400, body: { error: 'invalid_phone' } };
  }
  if (!rec) { rec = newRecord(id); records.unshift(rec); if (records.length > 20000) records.length = 20000; }
  if (d.role === 'student' || d.role === 'parent') { if (!rec.tests.length) rec.role = d.role; }
  if (['ЕГЭ', 'ОГЭ'].includes(d.exam)) rec.exam = d.exam;
  if (d.grade) rec.grade = clip(d.grade, 4);
  if (d.goal) rec.goal = clip(d.goal, 60);
  if (d.source && typeof d.source === 'object' && !Object.keys(rec.source).length) {
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (d.source[k]) rec.source[k] = clip(d.source[k], 80);
  }
  let advance = null;
  if (d.event === 'test_done') {
    const t = cleanTest(d.test);
    if (!t) return { code: 400, body: { error: 'invalid_test' } };
    rec.tests.push(t); if (rec.tests.length > 50) rec.tests.shift();
    pushEvent(rec, 'test_done'); advance = 'test_done';
  } else if (d.event === 'claimed') {
    const c = d.contact, teacher = PRICES[d.teacher] ? d.teacher : 'Ислам';
    const amount = Number(d.payment && d.payment.amount);
    if (!PRICES[teacher].includes(amount)) return { code: 400, body: { error: 'invalid_amount' } };
    rec.contact = { parent_name: clip(c.parent_name, 80), student_name: clip(c.student_name, 80), phone: clip(c.phone, 20).replace(/[^\d+]/g, ''), messenger: ['WhatsApp', 'Telegram', 'Звонок'].includes(c.messenger) ? c.messenger : 'WhatsApp', consent: true };
    rec.payment = Object.assign({}, rec.payment, { amount, payer: clip(d.payment.payer, 80) });
    rec.diagnostic.price = amount; rec.diagnostic.teacher = teacher;
    pushEvent(rec, 'claimed'); advance = 'claimed';
  } else if (d.event === 'trainer') {
    rec.trainer_opened_at = rec.trainer_opened_at || nowIso();
  } else {
    pushEvent(rec, d.event); if (d.event === 'clicked_signup') advance = 'clicked_signup';
  }
  if (advance && rec.stage !== 'lost' && SITE_ORDER.indexOf(advance) > SITE_ORDER.indexOf(rec.stage)) rec.stage = advance;
  rec.updated_at = nowIso();
  return { code: 200, body: { ok: true } };
}
// Как запись видит CRM. Пока платёжный сервис не подключён (шаг 7 инструкции), оплата диагностики идёт переводом
// по СБП и кнопкой «Я оплатил» (этап claimed). В новой CRM такого этапа нет, поэтому показываем его как «paid»,
// чтобы человек попал в колонку «Оплатил — позвонить», и добавляем заметку с суммой — команда сверяет поступление.
// В payments ничего не пишем: это не подтверждённый платёж, выручка в CRM его не считает. В базе этап остаётся claimed.
function crmView(r) {
  if (r.stage !== 'claimed') return r;
  const ev = (r.events || []).find((e) => e.type === 'claimed');
  const pay = r.payment || {};
  const text = `Сообщил о переводе по СБП${pay.amount ? ' ' + pay.amount + ' ₽' : ''}${pay.payer ? ', отправитель: ' + pay.payer : ''}${r.diagnostic && r.diagnostic.teacher ? ', преподаватель: ' + r.diagnostic.teacher : ''}. Проверьте поступление в банке.`;
  return { ...r, stage: 'paid', events: [...(r.events || []), { at: (ev && ev.at) || r.updated_at || r.created_at, type: 'paid' }],
    notes: [{ at: (ev && ev.at) || r.updated_at || r.created_at, author: 'Сайт', text }, ...(r.notes || [])] };
}
// что видит родитель по ссылке /r/<id>: последний тест семьи, без контактов и платежей
function publicRecord(r) {
  const t = r.tests[r.tests.length - 1];
  if (!t) return null;
  return { id: r.id, exam: r.exam, goal: r.goal, test: t.test, kind: t.kind, zone: t.zone, pos: t.pos ?? null, score: t.score, max: t.max, shown: t.shown || [], wrong: t.wrong, topics: t.errTopics || [], at: t.at };
}
// ---------- вход в CRM: пароль из окружения, в ответ — подписанная httpOnly-кука ----------
const CRM_PASSWORD = process.env.CRM_PASSWORD || ADMIN_PASSWORD;
const crmKey = () => crypto.createHash('sha256').update('crm-cookie:' + CRM_PASSWORD).digest();
function crmToken() { const exp = Date.now() + 30 * 864e5; return exp + '.' + crypto.createHmac('sha256', crmKey()).update(String(exp)).digest('hex'); }
function crmAuthed(req) {
  if (!CRM_PASSWORD) return false;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)crm=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac('sha256', crmKey()).update(exp).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const PAY = () => ({ phone: clip(process.env.SBP_PHONE, 30), bank: clip(process.env.SBP_BANK, 60), name: clip(process.env.SBP_NAME, 80) });

// ---------- оплата через ЮKassa (шаг 7 инструкции CRM) ----------
// Ключи — только в переменных окружения. Сумму всегда считает сервер, ссылке и браузеру не верим.
// Оплата засчитывается только по уведомлению ЮKassa (вебхуку), которое сервер перепроверяет запросом в API ЮKassa.
const YK = {
  shop: String(process.env.YOOKASSA_SHOP_ID || '').trim(),
  key: String(process.env.YOOKASSA_SECRET_KEY || '').trim(),
  receipt: process.env.YOOKASSA_RECEIPT === '1', // чеки по 54-ФЗ через ЮKassa: включить, если они включены в магазине
  vat: Number(process.env.YOOKASSA_VAT_CODE || 1), // 1 — без НДС
  api: String(process.env.YOOKASSA_API || 'https://api.yookassa.ru/v3').replace(/\/+$/, ''), // переопределяется только для проверок
};
const SITE_URL = String(process.env.SITE_URL || 'https://biocapybara.ru').replace(/\/+$/, '');
const DIAG_PRICES = { 'Ислам': { old: 2500, now: 2000 }, 'Абу-Бакр': { old: 1500, now: 1500 } };
const DISCOUNT_HOURS = 3; // как таймер на сайте: 3 часа после первого пройденного теста
const COURSE_TARIFFS = { // как в crm.html: цена в месяц и за весь курс; null — целиком не продаётся
  'CapyBasic': { m: 5000, full: 29500 },
  'Comfort-bara': { m: 6000, full: 35500 },
  'Capybarin-Pro': { m: 9800, full: null },
  'Capybarin-Pro MAX': { m: 13000, full: null },
};
const CREDIT_HOURS = 72; // зачёт диагностики в первую оплату курса
async function yk(method, apiPath, body, idemKey) {
  if (!YK.shop || !YK.key) { const e = new Error('yookassa_not_configured'); e.status = 503; throw e; }
  const r = await fetch(YK.api + apiPath, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(YK.shop + ':' + YK.key).toString('base64'), 'Content-Type': 'application/json', ...(idemKey ? { 'Idempotence-Key': idemKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('yookassa_' + r.status); e.status = r.status; e.body = j; throw e; }
  return j;
}
const okPays = (rec, purpose) => (rec.payments || []).filter((p) => p.status === 'succeeded' && (!purpose || p.purpose === purpose));
function discountUntil(rec) {
  const t = ((rec && rec.events) || []).filter((e) => e.type === 'test_done').map((e) => Date.parse(e.at)).filter(Number.isFinite);
  return t.length ? Math.min(...t) + DISCOUNT_HOURS * 3600000 : 0;
}
function diagPrice(rec, teacher) {
  const p = DIAG_PRICES[teacher];
  if (!p) return null;
  return discountUntil(rec) > Date.now() ? p.now : p.old;
}
function courseQuote(rec, tariff, plan) {
  const t = COURSE_TARIFFS[tariff];
  if (!t || (plan !== 'month' && plan !== 'full')) return null;
  const price = plan === 'full' ? t.full : t.m;
  if (!price) return null;
  const prev = okPays(rec, 'course');
  if (plan === 'full' && prev.length) return null; // весь курс — только первой покупкой
  const month_no = plan === 'month' ? prev.filter((p) => p.plan === 'month').length + 1 : null;
  let credit = 0;
  const diag = okPays(rec, 'diagnostic')[0];
  const doneEv = (rec.events || []).find((e) => e.type === 'diag_done');
  const doneAt = Date.parse((rec.diagnostic && rec.diagnostic.done_at) || (doneEv && doneEv.at) || '');
  if (!prev.length && diag && Number.isFinite(doneAt) && Date.now() - doneAt <= CREDIT_HOURS * 3600000) credit = Math.min(diag.amount, price - 1);
  return { tariff, plan, month_no, price, credit, amount: price - credit };
}
function advanceStage(rec, stage) {
  if (rec.stage === 'lost' || SITE_ORDER.indexOf(stage) > SITE_ORDER.indexOf(rec.stage)) rec.stage = stage;
}
// успешная оплата из ЮKassa → запись CRM (повторное уведомление по тому же платежу ничего не меняет)
async function applyPayment(pay) {
  const m = pay.metadata || {};
  const id = ID_RE.test(String(m.record_id || '')) ? m.record_id : null;
  let rec = id && records.find((r) => r.id === id);
  if (!rec) { rec = newRecord(id || ('p' + String(pay.id).replace(/[^\w]/g, '').slice(0, 12))); records.unshift(rec); }
  rec.payments = rec.payments || [];
  if (rec.payments.some((x) => x.id === pay.id)) return false;
  const purpose = m.purpose === 'course' ? 'course' : 'diagnostic';
  const first = !okPays(rec, purpose).length;
  const item = { id: pay.id, provider: 'yookassa', purpose, amount: Number(pay.amount && pay.amount.value) || 0, status: 'succeeded', paid_at: pay.captured_at || pay.created_at || nowIso() };
  if (pay.test) item.test = true;
  if (purpose === 'diagnostic') item.teacher = DIAG_PRICES[m.teacher] ? m.teacher : '';
  else {
    item.tariff = COURSE_TARIFFS[m.tariff] ? m.tariff : clip(m.tariff, 40);
    item.plan = m.plan === 'full' ? 'full' : 'month';
    if (Number(m.month_no) > 0) item.month_no = Number(m.month_no);
    if (Number(m.credit) > 0) item.credit = Number(m.credit);
  }
  rec.payments.push(item);
  rec.diagnostic = rec.diagnostic || {};
  if (purpose === 'diagnostic' && first) { pushEvent(rec, 'paid'); if (item.teacher) rec.diagnostic.teacher = item.teacher; rec.diagnostic.price = item.amount; advanceStage(rec, 'paid'); }
  if (purpose === 'course' && first) { pushEvent(rec, 'bought'); advanceStage(rec, 'bought'); }
  rec.updated_at = nowIso(); await saveRecords();
  return true;
}
async function applyRefund(rf) {
  for (const rec of records) {
    const p = (rec.payments || []).find((x) => x.id === rf.payment_id);
    if (!p) continue;
    p.refunds = p.refunds || [];
    if (p.refunds.some((x) => x.id === rf.id)) return false;
    p.refunds.push({ id: rf.id, amount: Number(rf.amount && rf.amount.value) || 0, at: rf.created_at || nowIso() });
    p.status = 'refunded'; p.refunded_at = rf.created_at || nowIso();
    rec.updated_at = nowIso(); await saveRecords();
    return true;
  }
  return false;
}

// ---------- статические файлы ----------
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/': ['admin.html', 'text/html; charset=utf-8'],
  '/crm': ['crm.html', 'text/html; charset=utf-8'],
  '/crm/': ['crm.html', 'text/html; charset=utf-8'],
  '/offer': ['offer.html', 'text/html; charset=utf-8'], // публичная оферта
  '/pay': ['pay.html', 'text/html; charset=utf-8'], // оплата курса по ссылке из CRM
  '/pay/thanks': ['pay.html', 'text/html; charset=utf-8'], // сюда ЮKassa возвращает после оплаты
};
const ICONS = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/icon-32.png': ['icon-32.png', 'image/png'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};
Object.assign(FILES, ICONS);
// данные тестов: вопросы, баллы, тексты лежат в отдельных файлах, их можно править без программиста
for (const n of ['t1', 't2', 't3', 'common', 'mock']) FILES['/tests/' + n + '.json'] = ['tests/' + n + '.json', 'application/json; charset=utf-8'];
const ICON_FILES = new Set(Object.values(ICONS).map((x) => x[0]));
const cache = {};
function serveFile(res, name, type, head) {
  try {
    if (!cache[name] || process.env.NODE_ENV === 'development') cache[name] = fs.readFileSync(path.join(ROOT, name));
    const extra = (name === 'admin.html' || name === 'crm.html') ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } : ICON_FILES.has(name) ? { 'Cache-Control': 'public, max-age=86400' } : { 'Cache-Control': 'no-cache' };
    res.writeHead(200, { 'Content-Type': type, ...SEC, ...extra });
    res.end(head ? undefined : cache[name]);
  } catch { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
}

// ---------- маршруты ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (FILES[p] && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(res, FILES[p][0], FILES[p][1], req.method === 'HEAD');
    if (p === '/healthz') return send(res, 200, { ok: true });

    // страница для родителя: та же страница сайта, данные подтягиваются по номеру записи
    if (/^\/r\/[\w-]{4,16}$/.test(p) && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveFile(res, 'index.html', 'text/html; charset=utf-8', req.method === 'HEAD');
    }

    // события с сайта (публично): создаёт запись семьи или дополняет её
    if (p === '/api/track' && req.method === 'POST') {
      if (rateLimited('trk:' + clientIp(req), 80)) return send(res, 429, { error: 'too_many' });
      let data; try { data = JSON.parse(await readBody(req, 50000)); } catch { return send(res, 400, { error: 'bad_json' }); }
      const r = applyTrack(data || {});
      if (r.code === 200) await saveRecords();
      return send(res, r.code, r.body);
    }
    // страница для родителя читает результат по номеру записи
    const rm = p.match(/^\/api\/records\/([\w-]{4,16})$/);
    if (rm && req.method === 'GET') {
      const rec = records.find((r) => r.id === rm[1]);
      const pub = rec && publicRecord(rec);
      if (!pub) return send(res, 404, { error: 'not_found' });
      return send(res, 200, pub, undefined, { 'Cache-Control': 'no-store' });
    }
    // реквизиты для перевода по СБП берутся из переменных окружения, в коде их нет
    if (p === '/api/pay-info' && req.method === 'GET') return send(res, 200, PAY(), undefined, { 'Cache-Control': 'no-store' });

    // ---------- оплата через ЮKassa ----------
    // цены для показа на сайте и на странице /pay (без персональных данных)
    if (p === '/api/pay/quote' && req.method === 'GET') {
      const id = clip(url.searchParams.get('r'), 16);
      const rec = ID_RE.test(id) ? records.find((r) => r.id === id) : null;
      const nc = { 'Cache-Control': 'no-store' };
      if (url.searchParams.get('p') === 'course') {
        if (!rec) return send(res, 404, { error: 'not_found' }, undefined, nc);
        const q = courseQuote(rec, clip(url.searchParams.get('tariff'), 40), url.searchParams.get('plan'));
        if (!q) return send(res, 400, { error: 'invalid_tariff' }, undefined, nc);
        return send(res, 200, { ...q, ready: !!(YK.shop && YK.key) }, undefined, nc);
      }
      const prices = {}; for (const t of Object.keys(DIAG_PRICES)) prices[t] = diagPrice(rec, t);
      const du = discountUntil(rec);
      return send(res, 200, { prices, old: DIAG_PRICES['Ислам'].old, discount_until: du > Date.now() ? new Date(du).toISOString() : null, ready: !!(YK.shop && YK.key) }, undefined, nc);
    }
    // создать платёж: диагностика (с контактами и согласием) или курс (по записи из CRM)
    if (p === '/api/pay/create' && req.method === 'POST') {
      if (rateLimited('pay:' + clientIp(req), 20)) return send(res, 429, { error: 'too_many' });
      let data; try { data = JSON.parse(await readBody(req, 5000)); } catch { return send(res, 400, { error: 'bad_json' }); }
      const id = clip(data && data.id, 16);
      if (!ID_RE.test(id)) return send(res, 400, { error: 'invalid' });
      if (!YK.shop || !YK.key) return send(res, 503, { error: 'pay_not_configured' });
      let rec = records.find((r) => r.id === id);
      let amount, description, metadata, phone;
      if (data.purpose === 'diagnostic') {
        const c = data.contact || {};
        if (c.consent !== true) return send(res, 400, { error: 'consent_required' });
        phone = clip(c.phone, 20).replace(/[^\d+]/g, '');
        if (!/^\+7\d{10}$/.test(phone)) return send(res, 400, { error: 'invalid_phone' });
        if (!clip(c.parent_name, 80) || !clip(c.student_name, 80)) return send(res, 400, { error: 'invalid_name' });
        const teacher = DIAG_PRICES[data.teacher] ? data.teacher : null;
        if (!teacher) return send(res, 400, { error: 'invalid_teacher' });
        if (!rec) { rec = newRecord(id); records.unshift(rec); }
        rec.contact = { parent_name: clip(c.parent_name, 80), student_name: clip(c.student_name, 80), phone, messenger: ['WhatsApp', 'Telegram', 'Звонок'].includes(c.messenger) ? c.messenger : 'Звонок', consent: true };
        rec.updated_at = nowIso(); await saveRecords();
        amount = diagPrice(rec, teacher);
        description = `Диагностика по биологии · ${teacher}`;
        metadata = { record_id: id, purpose: 'diagnostic', teacher };
      } else if (data.purpose === 'course') {
        if (!rec) return send(res, 404, { error: 'not_found' });
        const q = courseQuote(rec, clip(data.tariff, 40), data.plan);
        if (!q) return send(res, 400, { error: 'invalid_tariff' });
        amount = q.amount; phone = rec.contact && rec.contact.phone;
        description = `Курс ${q.tariff} · ${q.plan === 'full' ? 'весь курс' : 'месяц ' + q.month_no}`;
        metadata = { record_id: id, purpose: 'course', tariff: q.tariff, plan: q.plan, month_no: String(q.month_no || ''), credit: String(q.credit || 0) };
      } else return send(res, 400, { error: 'invalid_purpose' });
      const body = { amount: { value: amount.toFixed(2), currency: 'RUB' }, capture: true, confirmation: { type: 'redirect', return_url: `${SITE_URL}/pay/thanks?r=${encodeURIComponent(id)}` }, description: description.slice(0, 128), metadata };
      if (YK.receipt) {
        if (!/^\+7\d{10}$/.test(phone || '')) return send(res, 400, { error: 'phone_required' });
        body.receipt = { customer: { phone: phone.slice(1) }, items: [{ description: description.slice(0, 128), quantity: '1.00', amount: body.amount, vat_code: YK.vat, payment_mode: 'full_payment', payment_subject: 'service' }] };
      }
      try {
        const pay = await yk('POST', '/payments', body, crypto.randomUUID());
        return send(res, 200, { url: pay.confirmation && pay.confirmation.confirmation_url, amount });
      } catch (e) {
        console.error('ЮKassa: не создался платёж', e.status, JSON.stringify(e.body || {}));
        return send(res, 502, { error: 'pay_failed' });
      }
    }
    // уведомления ЮKassa. Телу не верим: статус платежа/возврата перепроверяем запросом в API ЮKassa
    if (p === '/api/pay/webhook' && req.method === 'POST') {
      let data; try { data = JSON.parse(await readBody(req, 20000)); } catch { return send(res, 400, { error: 'bad_json' }); }
      const ev = String((data && data.event) || ''), objId = clip(data && data.object && data.object.id, 64);
      if (!/^[\w-]{10,64}$/.test(objId)) return send(res, 200, { ok: true });
      try {
        if (ev === 'payment.succeeded') {
          const pay = await yk('GET', '/payments/' + encodeURIComponent(objId));
          if (pay.status === 'succeeded' && pay.paid) await applyPayment(pay);
        } else if (ev === 'refund.succeeded') {
          const rf = await yk('GET', '/refunds/' + encodeURIComponent(objId));
          if (rf.status === 'succeeded') await applyRefund(rf);
        }
      } catch (e) {
        if (e.status === 404) return send(res, 200, { ok: true }); // такого платежа в магазине нет — подделка
        console.error('ЮKassa: вебхук не обработан', ev, objId, e.status || e.message);
        return send(res, 500, { error: 'retry' }); // ЮKassa повторит уведомление
      }
      return send(res, 200, { ok: true });
    }

    // CRM (только после входа)
    if (p === '/api/crm/login' && req.method === 'POST') {
      if (!CRM_PASSWORD) return send(res, 503, { error: 'no_password_configured' });
      if (rateLimited('login:' + clientIp(req), 10)) return send(res, 429, { error: 'too_many' });
      let data; try { data = JSON.parse(await readBody(req, 2000)); } catch { return send(res, 400, { error: 'bad_json' }); }
      const a = crypto.createHash('sha256').update(String(data.password || '')).digest();
      const b = crypto.createHash('sha256').update(CRM_PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'unauthorized' });
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `crm=${encodeURIComponent(crmToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`, 'Cache-Control': 'no-store' });
    }
    if (p.startsWith('/api/crm/')) {
      if (!crmAuthed(req)) return send(res, 401, { error: 'unauthorized' }, undefined, { 'Cache-Control': 'no-store' });
      if (p === '/api/crm/records' && req.method === 'GET') return send(res, 200, { records: records.map(crmView) }, undefined, { 'Cache-Control': 'no-store' });
      const cm = p.match(/^\/api\/crm\/records\/([\w-]{4,16})(\/notes)?$/);
      if (cm) {
        const rec = records.find((r) => r.id === cm[1]);
        if (!rec) return send(res, 404, { error: 'not_found' });
        // удаление записи из CRM; копия уходит в корзину crm-deleted.json (последние 500) — на случай ошибки
        if (!cm[2] && req.method === 'DELETE') {
          let trash = [];
          try { trash = JSON.parse(fs.readFileSync(TRASH_FILE, 'utf8')); if (!Array.isArray(trash)) trash = []; } catch { trash = []; }
          trash.unshift({ deleted_at: nowIso(), record: rec }); if (trash.length > 500) trash.length = 500;
          const tmp = TRASH_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(trash, null, 1)); fs.renameSync(tmp, TRASH_FILE);
          records.splice(records.indexOf(rec), 1); await saveRecords();
          return send(res, 200, { ok: true });
        }
        let data; try { data = JSON.parse(await readBody(req, 60000)); } catch { return send(res, 400, { error: 'bad_json' }); }
        if (cm[2] && req.method === 'POST') {
          const text = clip(data.text, 1000);
          if (!text) return send(res, 400, { error: 'invalid' });
          rec.notes = rec.notes || [];
          rec.notes.push({ at: (typeof data.at === 'string' && !isNaN(Date.parse(data.at))) ? new Date(data.at).toISOString() : nowIso(), author: clip(data.author, 40), text });
          rec.updated_at = nowIso(); await saveRecords();
          return send(res, 201, { ok: true });
        }
        if (!cm[2] && req.method === 'PATCH') {
          // CRM показывает claimed как paid (см. crmView): если команда не трогала этап, не перезаписываем claimed
          if (ALL_STAGES.includes(data.stage) && !(rec.stage === 'claimed' && data.stage === 'paid')) rec.stage = data.stage;
          // события только дополняем: сайт мог добавить свои, пока CRM была открыта
          if (Array.isArray(data.events)) {
            const have = new Set((rec.events || []).map((e) => e.type + '|' + e.at));
            for (const e of data.events.slice(0, 100)) {
              if (e && e.type === 'paid' && rec.stage === 'claimed') continue; // «paid» — из crmView, а не настоящая оплата
              const type = clip(e && e.type, 30), at = (e && typeof e.at === 'string' && !isNaN(Date.parse(e.at))) ? new Date(e.at).toISOString() : null;
              if (type && at && !have.has(type + '|' + at)) { rec.events.push({ at, type }); have.add(type + '|' + at); }
            }
          }
          // по инструкции CRM меняет только contact и diagnostic; оплаты (payment/payments) через CRM не меняются
          for (const k of ['contact', 'diagnostic']) if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) rec[k] = JSON.parse(JSON.stringify(data[k]));
          if (typeof data.lost_reason === 'string') rec.lost_reason = clip(data.lost_reason, 200);
          rec.updated_at = nowIso(); await saveRecords();
          return send(res, 200, { record: crmView(rec) });
        }
      }
      return send(res, 404, { error: 'not_found' });
    }

    // приём заявки с сайта
    if (p === '/api/leads' && req.method === 'POST') {
      if (rateLimited(clientIp(req))) return send(res, 429, { error: 'too_many' });
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad_json' }); }
      if (data.website) return send(res, 201, { ok: true }); // скрытое поле-ловушка для ботов
      const name = clip(data.name, 80);
      const phone = clip(data.phone, 20).replace(/[^\d+]/g, '');
      if (!name || !/^\+7\d{10}$/.test(phone)) return send(res, 400, { error: 'invalid' });
      const lead = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        name, phone,
        who: ['Ученик', 'Родитель'].includes(data.who) ? data.who : 'Ученик',
        exam: ['ЕГЭ', 'ОГЭ'].includes(data.exam) ? data.exam : 'ЕГЭ',
        price: [2000, 2500].includes(Number(data.price)) ? Number(data.price) : 2500, // стоимость диагностики, которую видел посетитель
        grade: [6, 7, 8, 9, 10, 11].includes(Number(data.grade)) ? Number(data.grade) : null,
        status: 'new',
        note: '',
        results: cleanResults(data.results),
        recordId: null,
        utm: {},
      };
      if (data.utm && typeof data.utm === 'object') for (const k of ['source', 'medium', 'campaign', 'content', 'term']) if (data.utm[k]) lead.utm[k] = clip(data.utm[k], 80);
      leads.unshift(lead);
      await save();
      return send(res, 201, { ok: true });
    }

    // админка
    if (p.startsWith('/api/admin/')) {
      if (!ADMIN_PASSWORD) return send(res, 503, { error: 'no_password_configured' });
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      if (p === '/api/admin/leads' && req.method === 'GET') return send(res, 200, { leads }, undefined, { 'Cache-Control': 'no-store' });
      const m = p.match(/^\/api\/admin\/leads\/([\w-]{36})$/);
      if (m) {
        const lead = leads.find((l) => l.id === m[1]);
        if (!lead) return send(res, 404, { error: 'not_found' });
        if (req.method === 'PATCH') {
          let data; try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad_json' }); }
          if (['new', 'called', 'enrolled', 'rejected'].includes(data.status)) lead.status = data.status;
          if (typeof data.note === 'string') lead.note = clip(data.note, 500);
          await save();
          return send(res, 200, { lead });
        }
        if (req.method === 'DELETE') { leads = leads.filter((l) => l.id !== lead.id); await save(); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'not_found' });
    }
    send(res, 404, 'Страница не найдена', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server' });
  }
});

server.listen(PORT, () => {
  console.log(`bio_capybara: порт ${PORT}, заявки в ${LEADS_FILE}, заявок: ${leads.length}, записей тестов: ${records.length}`);
  if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD не задан — админ-панель закрыта');
});
