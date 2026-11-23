import { safeEqual } from './lib/crypto.js';
import { createStore } from './tg/store.js';
import { HttpError } from './tg/engine.js';

const VERSION = '0.1.4';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function checkDatabase(env) {
  if (!env.DB) return { status: 'not_configured', leadsCount: null };
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM leads').first();
    return { status: 'connected', leadsCount: Number(row?.total ?? 0) };
  } catch {
    return { status: 'schema_missing_or_unavailable', leadsCount: null };
  }
}

async function health(request, env) {
  const database = await checkDatabase(env);
  const ok = database.status === 'connected';
  return json({
    ok,
    app: 'Lead Database Manager',
    version: VERSION,
    checks: {
      worker: 'ok',
      database: database.status,
    },
    leads_count: database.leadsCount,
    checked_at: new Date().toISOString(),
  }, ok ? 200 : 503);
}

// ---------- admin API ----------
const failedAuth = new Map(); // per-isolate brute-force damper; real rate limiting arrives with stage 10

async function isAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 20) return { ok: false, reason: 'admin_not_configured' };
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rec = failedAuth.get(ip);
  if (rec && rec.count >= 10 && Date.now() - rec.at < 10 * 60_000) return { ok: false, reason: 'too_many_attempts' };
  if (await safeEqual(token, env.ADMIN_TOKEN)) { failedAuth.delete(ip); return { ok: true }; }
  failedAuth.set(ip, { count: (rec && Date.now() - rec.at < 10 * 60_000 ? rec.count : 0) + 1, at: Date.now() });
  return { ok: false, reason: 'unauthorized' };
}

async function readJson(request, max = 20_000) {
  const raw = await request.text();
  if (raw.length > max) throw new HttpError(413, 'Слишком большой запрос.');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Некорректный JSON.'); }
}

function tg(env) {
  if (!env.TG) throw new HttpError(503, 'Durable Object TG не подключён (см. wrangler.jsonc).');
  const stub = env.TG.get(env.TG.idFromName('main'));
  return async (method, ...args) => {
    const res = await stub.invoke(method, args);
    if (!res.ok) throw new HttpError(res.status || 502, res.error || 'Ошибка Telegram-модуля.');
    return res.data;
  };
}

function needSecrets(env) {
  if (!env.DB) throw new HttpError(503, 'Не подключена база D1 (binding DB).');
  if (!env.APP_SECRET || env.APP_SECRET.length < 24) throw new HttpError(503, 'Не задан секрет APP_SECRET (24+ символов).');
}

const KYIV = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function formatKyiv(value) {
  if (!value) return '';
  const text = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return text;
  return KYIV.format(date);
}

export const EXPORT_HEADERS = ['Имя', 'Ник', 'Номер телефона', 'Источник', 'Дата добавления в базу', 'Текст сообщения (триггер)'];
const EXPORT_PAGE = 500;

export function leadToExportRow(l) {
  const name = [l.first_name, l.last_name].filter(Boolean).join(' ').trim();
  return [
    name || '—',
    l.username ? `@${l.username}` : '—',
    l.phone || 'Nope',
    l.source_title || '—',
    formatKyiv(l.created_at),
    l.trigger_text || '',
  ];
}

// The .xlsx file is assembled in the browser (public/lib/xlsx.js): building a workbook costs far more CPU than the free
// Workers plan allows per request. The server only hands out ready-made rows, one cheap page at a time.
async function exportPage(env, url) {
  const store = createStore(env.DB);
  const after = Math.max(parseInt(url.searchParams.get('after') || '0', 10) || 0, 0);
  const batch = await store.leadsBatch(after, EXPORT_PAGE);
  const total = after === 0 ? await store.countLeads() : undefined;
  return json({
    ok: true,
    data: {
      headers: EXPORT_HEADERS,
      rows: batch.map(leadToExportRow),
      next: batch.length === EXPORT_PAGE ? batch[batch.length - 1].rid : null,
      total,
    },
  });
}

async function workerConfigSteps(env) {
  const steps = [];
  steps.push({ name: 'admin', title: 'Ключ доступа ADMIN_TOKEN', ok: Boolean(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 20), detail: '' });
  steps.push({ name: 'secret', title: 'Секрет шифрования APP_SECRET (24+ символов)', ok: Boolean(env.APP_SECRET && env.APP_SECRET.length >= 24), detail: '' });
  steps.push({ name: 'do', title: 'Durable Object (TG) подключён', ok: Boolean(env.TG), detail: '' });
  let schema = false;
  let detail = '';
  if (env.DB) {
    try { await env.DB.prepare('SELECT 1 FROM tg_app_credentials LIMIT 1').first(); schema = true; } catch { detail = 'Выполните миграцию 0003 в D1 → SQL Console.'; }
  } else detail = 'Нет binding DB.';
  steps.push({ name: 'schema', title: 'База D1: миграция 0003 применена', ok: schema, detail });
  return steps;
}

async function adminApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const route = `${method} ${pathname}`;

  if (route === 'GET /api/auth/check') return json({ ok: true });

  needSecrets(env);
  const store = createStore(env.DB);
  const call = tg(env);

  if (route === 'GET /api/tg/status') return json({ ok: true, data: await call('status', { wake: true }) });
  if (route === 'POST /api/tg/credentials') { const b = await readJson(request); return json({ ok: true, data: await call('saveCredentials', b.api_id, b.api_hash) }); }
  if (route === 'POST /api/tg/login/qr') return json({ ok: true, data: await call('startQr') });
  if (route === 'POST /api/tg/login/phone') { const b = await readJson(request); return json({ ok: true, data: await call('startPhone', b.phone) }); }
  if (route === 'POST /api/tg/login/code') { const b = await readJson(request); return json({ ok: true, data: await call('submitCode', b.code) }); }
  if (route === 'POST /api/tg/login/password') { const b = await readJson(request); return json({ ok: true, data: await call('submitPassword', b.password) }); }
  if (route === 'POST /api/tg/login/cancel') return json({ ok: true, data: await call('cancelLogin') });
  if (route === 'POST /api/tg/logout') { const b = await readJson(request); if (b.confirm !== 'LOGOUT') throw new HttpError(400, 'Нужно подтверждение.'); return json({ ok: true, data: await call('logout') }); }
  if (route === 'GET /api/tg/dialogs') return json({ ok: true, data: await call('listDialogs') });
  if (route === 'GET /api/tg/diagnostics') {
    const config = await workerConfigSteps(env);
    let remote = { steps: [] };
    if (config.every((s) => s.ok)) remote = await call('runDiagnostics');
    return json({ ok: true, data: { steps: [...config, ...remote.steps] } });
  }

  if (route === 'GET /api/monitor/state') return json({ ok: true, data: await call('monitorState') });
  if (route === 'POST /api/monitor/settings') { const b = await readJson(request); return json({ ok: true, data: await call('saveMonitorSettings', b) }); }
  if (route === 'POST /api/monitor/sources') { const b = await readJson(request); return json({ ok: true, data: await call('addSource', b.id) }); }
  if (route === 'POST /api/monitor/sources/remove') { const b = await readJson(request); return json({ ok: true, data: await call('removeSource', b.id) }); }
  if (route === 'POST /api/monitor/check') { const b = await readJson(request); return json({ ok: true, data: await call('runCheck', { backfill: b.backfill }) }); }

  if (route === 'GET /api/leads') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const data = await store.listLeads({ q: url.searchParams.get('q') || '', limit, offset: (page - 1) * limit });
    return json({ ok: true, data: { ...data, page, limit } });
  }
  if (route === 'POST /api/leads/clear') {
    const b = await readJson(request);
    if (b.confirm !== 'DELETE') throw new HttpError(400, 'Нужно подтверждение.');
    await store.clearLeads();
    await store.addLog('warn', 'Тестовая база лидов очищена вручную');
    return json({ ok: true });
  }
  if (route === 'GET /api/export/leads') return exportPage(env, url);

  return json({ ok: false, error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') {
      if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
      return health(request, env);
    }
    if (pathname.startsWith('/api/')) {
      const auth = await isAdmin(request, env);
      if (!auth.ok) {
        const status = auth.reason === 'admin_not_configured' ? 503 : auth.reason === 'too_many_attempts' ? 429 : 401;
        return json({ ok: false, error: auth.reason }, status);
      }
      try {
        return await adminApi(request, env, url);
      } catch (error) {
        if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status);
        console.error('admin_api_failed', error?.message || 'unknown');
        return json({ ok: false, error: 'Внутренняя ошибка сервера.' }, 500);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
