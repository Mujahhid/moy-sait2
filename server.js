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
const ROOT = __dirname;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- хранилище заявок (JSON-файл, запись через временный файл) ----------
let leads = [];
try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); if (!Array.isArray(leads)) leads = []; } catch { leads = []; }
let saving = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(leads, null, 1);
  saving = saving.then(() => new Promise((resolve) => {
    const tmp = LEADS_FILE + '.tmp';
    fs.writeFile(tmp, snapshot, (e) => {
      if (e) { console.error('save failed', e); return resolve(); }
      fs.rename(tmp, LEADS_FILE, (e2) => { if (e2) console.error('rename failed', e2); resolve(); });
    });
  }));
  return saving;
}

// ---------- защита от спама: не больше 5 заявок с одного адреса за 10 минут ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > 5;
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
  'X-Frame-Options': 'DENY',
};
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...SEC, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------- статические файлы ----------
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/': ['admin.html', 'text/html; charset=utf-8'],
};
const cache = {};
function serveFile(res, name, type, head) {
  try {
    if (!cache[name] || process.env.NODE_ENV === 'development') cache[name] = fs.readFileSync(path.join(ROOT, name));
    const extra = name === 'admin.html' ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } : { 'Cache-Control': 'public, max-age=300' };
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
        status: 'new',
        note: '',
      };
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
  console.log(`bio_capybara: порт ${PORT}, заявки в ${LEADS_FILE}, заявок: ${leads.length}`);
  if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD не задан — админ-панель закрыта');
});
