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
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const ROOT = __dirname;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- хранилище заявок (JSON-файл, запись через временный файл) ----------
let leads = [];
try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); if (!Array.isArray(leads)) leads = []; } catch { leads = []; }
// записи прохождений тестов (под будущую CRM): одна запись = одно прохождение
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

// ---------- записи тестов ----------
// статусы воронки по возрастанию; хранится самый дальний шаг, достигнутый записью
const STAGES = ['test', 'shared', 'viewed', 'cta', 'lead', 'diagnosed', 'bought'];
const TEST_IDS = ['t1', 't2', 't3', 'mock-oge', 'mock-ege'];
const ZONES = ['green', 'yellow', 'red'];
const newRecordId = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 7);
function bumpStage(rec, stage) {
  if (STAGES.indexOf(stage) > STAGES.indexOf(rec.status)) rec.status = stage;
  rec.events = rec.events || {};
  if (!rec.events[stage]) rec.events[stage] = new Date().toISOString();
}
function cleanRecord(d) {
  const num = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 100) / 100 : null);
  const rec = {
    id: newRecordId(),
    createdAt: new Date().toISOString(),
    test: TEST_IDS.includes(d.test) ? d.test : null,
    title: clip(d.title, 120),
    role: d.role === 'Родитель' ? 'Родитель' : 'Ученик',
    exam: ['ЕГЭ', 'ОГЭ'].includes(d.exam) ? d.exam : '',
    zone: ZONES.includes(d.zone) ? d.zone : '',
    pos: num(d.pos, 100),
    score: num(d.score, 1000),
    max: num(d.max, 1000),
    goal: ['med', 'vuz', 'pass'].includes(d.goal) ? d.goal : '',
    seconds: num(d.seconds, 86400),
    topics: Array.isArray(d.topics) ? d.topics.slice(0, 12).map((t) => ({ name: clip(t && t.name, 60), err: num(t && t.err, 100), of: num(t && t.of, 100), lost: num(t && t.lost, 1000) })).filter((t) => t.name) : [],
    result: clip(d.result, 200),          // тариф / специальность(и) / «пробник»
    shown: Array.isArray(d.shown) ? d.shown.slice(0, 12).map((x) => clip(x, 200)) : [],
    wrong: Array.isArray(d.wrong) ? d.wrong.slice(0, 40).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100) : [],
    answers: Array.isArray(d.answers) ? d.answers.slice(0, 30).map((a) => ({ q: clip(a && a.q, 160), a: clip(a && a.a, 160) })) : [],
    utm: {},
    status: 'test',
    events: { test: new Date().toISOString() },
    leadId: null,
  };
  if (d.utm && typeof d.utm === 'object') for (const k of ['source', 'medium', 'campaign', 'content', 'term']) if (d.utm[k]) rec.utm[k] = clip(d.utm[k], 80);
  return rec;
}
// что видит родитель по ссылке /r/<id> — только нужное для страницы, без телефонов и прочего
const publicRecord = (r) => ({ goal: r.goal, topics: r.topics, id: r.id, test: r.test, title: r.title, exam: r.exam, zone: r.zone, pos: r.pos, score: r.score, max: r.max, result: r.result, shown: r.shown, wrong: r.wrong, createdAt: r.createdAt });

// ---------- статические файлы ----------
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/': ['admin.html', 'text/html; charset=utf-8'],
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
    const extra = name === 'admin.html' ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } : ICON_FILES.has(name) ? { 'Cache-Control': 'public, max-age=86400' } : { 'Cache-Control': 'no-cache' };
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

    // новая запись о прохождении теста (тест анонимный: имени и телефона здесь нет)
    if (p === '/api/records' && req.method === 'POST') {
      if (rateLimited('rec:' + clientIp(req), 40)) return send(res, 429, { error: 'too_many' });
      let data; try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad_json' }); }
      const rec = cleanRecord(data || {});
      if (!rec.test) return send(res, 400, { error: 'invalid' });
      records.unshift(rec);
      if (records.length > 20000) records.length = 20000;
      await saveRecords();
      return send(res, 201, { id: rec.id });
    }
    const rm = p.match(/^\/api\/records\/([\w-]{4,16})(\/event)?$/);
    if (rm) {
      const rec = records.find((r) => r.id === rm[1]);
      if (!rec) return send(res, 404, { error: 'not_found' });
      if (!rm[2] && req.method === 'GET') return send(res, 200, publicRecord(rec), undefined, { 'Cache-Control': 'no-store' });
      if (rm[2] && req.method === 'POST') {
        if (rateLimited('ev:' + clientIp(req), 120)) return send(res, 429, { error: 'too_many' });
        let data; try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad_json' }); }
        if (data.type === 'trainer') { rec.events = rec.events || {}; if (!rec.events.trainer) { rec.events.trainer = new Date().toISOString(); await saveRecords(); } return send(res, 200, { ok: true }); }
        if (['shared', 'viewed', 'cta'].includes(data.type)) {
          bumpStage(rec, data.type);
          if (data.type === 'viewed') rec.viewedBy = 'parent';
          await saveRecords();
        }
        return send(res, 200, { ok: true });
      }
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
      const rid = typeof data.recordId === 'string' ? data.recordId : '';
      const rec = /^[\w-]{4,16}$/.test(rid) ? records.find((r) => r.id === rid) : null;
      if (rec) { lead.recordId = rec.id; rec.leadId = lead.id; rec.contactName = name; bumpStage(rec, 'lead'); if (!Object.keys(lead.utm).length) lead.utm = rec.utm || {}; await saveRecords(); }
      leads.unshift(lead);
      await save();
      return send(res, 201, { ok: true });
    }

    // админка
    if (p.startsWith('/api/admin/')) {
      if (!ADMIN_PASSWORD) return send(res, 503, { error: 'no_password_configured' });
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      if (p === '/api/admin/leads' && req.method === 'GET') return send(res, 200, { leads }, undefined, { 'Cache-Control': 'no-store' });
      if (p === '/api/admin/records' && req.method === 'GET') return send(res, 200, { records }, undefined, { 'Cache-Control': 'no-store' });
      const rr = p.match(/^\/api\/admin\/records\/([\w-]{4,16})$/);
      if (rr && req.method === 'PATCH') {
        const rec = records.find((r) => r.id === rr[1]);
        if (!rec) return send(res, 404, { error: 'not_found' });
        let data; try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad_json' }); }
        if (STAGES.includes(data.status) && ['diagnosed', 'bought'].includes(data.status)) bumpStage(rec, data.status);
        await saveRecords();
        return send(res, 200, { record: rec });
      }
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
