// Telegram account engine: login state machine (QR / phone), session persistence, chat monitoring.
// Transport-agnostic: it talks to Telegram only through the `client` interface created by makeClient(),
// so the whole logic is testable without network (see tests/engine.test.js).
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { matchTrigger } from '../lib/triggers.js';

const ERRORS_RU = [
  [/PHONE_NUMBER_INVALID/, 'Неверный номер телефона.'],
  [/PHONE_CODE_INVALID/, 'Неверный код. Проверьте и введите ещё раз.'],
  [/PHONE_CODE_EXPIRED/, 'Код устарел. Запросите вход заново.'],
  [/PASSWORD_HASH_INVALID/, 'Неверный пароль двухфакторной защиты.'],
  [/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/, 'Telegram не принял API ID / API hash. Проверьте значения на my.telegram.org.'],
  [/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/, 'Сессия отозвана или недействительна. Войдите заново.'],
  [/CHANNEL_PRIVATE|CHAT_FORBIDDEN|CHANNEL_INVALID/, 'Нет доступа к чату (он приватный или аккаунт не участник).'],
  [/MSG_ID_INVALID|PEER_ID_INVALID/, 'Чат недоступен для этого аккаунта.'],
  [/LOGIN_CANCELLED/, 'Вход отменён.'],
  [/LOGIN_TIMEOUT:qr/, 'Соединение с Telegram установлено, но QR-код не пришёл за 40 секунд. Нажмите «Диагностика» и пришлите результат.'],
  [/LOGIN_TIMEOUT:code/, 'Telegram не ответил на запрос кода за 40 секунд. Попробуйте ещё раз или откройте «Диагностику».'],
  [/LOGIN_TIMEOUT|timeout:connect/, 'Не удалось установить соединение с Telegram за 40 секунд. Нажмите «Диагностика» — она покажет, на каком шаге остановка.'],
];
const LOGIN_WAIT_MS = 40000;
const FATAL_SESSION = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/;

export function errorCode(err) {
  return String(err?.errorMessage || err?.message || err || 'unknown');
}
export function describeError(err) {
  const code = errorCode(err);
  const flood = code.match(/FLOOD_WAIT_?(\d+)?/) || (err?.seconds ? [code, String(err.seconds)] : null);
  if (flood) return `Telegram просит подождать${flood[1] ? ` ${flood[1]} с` : ''} (ограничение частоты запросов).`;
  for (const [re, text] of ERRORS_RU) if (re.test(code)) return text;
  return `Ошибка Telegram: ${code.slice(0, 200)}`;
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a cancelled login must not surface as an unhandled rejection
  return { promise, resolve, reject };
}

export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

function maskPhone(phone) {
  const p = normalizePhone(phone);
  return p ? `${p.slice(0, 4)}${'•'.repeat(Math.max(0, p.length - 6))}${p.slice(-2)}` : null;
}

export class TgEngine {
  constructor({ store, makeClient, secret, envCreds = {}, scheduleAlarm = async () => {}, diagnose = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
    Object.assign(this, { store, makeClient, secret, envCreds, scheduleAlarm, diagnose, sleep, now });
    this.client = null;
    this.state = 'logged_out';
    this.me = null;
    this.qr = null;
    this.passwordHint = null;
    this.error = null;
    this.notice = null;
    this.flow = null;
    this.flowSeq = 0;
    this.loaded = false;
    this.connecting = null;
    this.dialogs = [];
    this.pausedUntil = 0;
    this.stage = null; // what a login in progress is waiting for: 'connect' | 'qr' | 'code'
  }

  // ---------- state ----------
  async load() {
    if (this.loaded) return;
    const acc = await this.store.getAccount();
    this.account = acc;
    if (acc?.me_json) { try { this.me = JSON.parse(acc.me_json); } catch { this.me = null; } }
    if (acc?.session_enc) this.state = 'disconnected';
    this.loaded = true;
  }

  async getCreds() {
    if (this.envCreds.apiId && this.envCreds.apiHash) {
      return { apiId: Number(this.envCreds.apiId), apiHash: String(this.envCreds.apiHash), source: 'env' };
    }
    const saved = await this.store.getAppCredentials();
    if (saved?.api_id_enc && saved?.api_hash_enc) {
      return {
        apiId: Number(await decryptSecret(this.secret, saved.api_id_enc)),
        apiHash: await decryptSecret(this.secret, saved.api_hash_enc),
        source: 'saved',
      };
    }
    return null;
  }

  async status({ wake = false } = {}) {
    await this.load();
    // After a Durable Object restart the saved session is dormant; the API asks us to reconnect it in the background.
    if (wake && this.state === 'disconnected' && !this.connecting && !this.flow) this.ensureConnected().catch(() => {});
    const [acc, savedCreds] = await Promise.all([this.store.getAccount(), this.store.getAppCredentials()]);
    const envConfigured = Boolean(this.envCreds.apiId && this.envCreds.apiHash);
    const hasCreds = Boolean(envConfigured || (savedCreds?.api_id_enc && savedCreds?.api_hash_enc));
    return {
      state: this.state,
      stage: this.state === 'connecting' ? this.stage : null,
      hasCredentials: hasCreds,
      credentialsSource: envConfigured ? 'env' : (hasCreds ? 'saved' : null),
      hasSession: Boolean(acc?.session_enc),
      qr: this.state === 'qr_pending' ? this.qr : null,
      passwordHint: this.state === 'password_needed' ? this.passwordHint : null,
      notice: this.notice,
      error: this.error,
      me: this.me ? { id: this.me.id, firstName: this.me.firstName, lastName: this.me.lastName, username: this.me.username, phoneMasked: maskPhone(this.me.phone) } : null,
    };
  }

  async waitFor(predicate, timeoutMs) {
    const end = this.now() + timeoutMs;
    while (this.now() < end) {
      if (predicate()) return true;
      await this.sleep(100);
    }
    return predicate();
  }

  // ---------- credentials ----------
  async saveCredentials(apiId, apiHash) {
    const id = String(apiId ?? '').trim();
    const hash = String(apiHash ?? '').trim();
    if (!/^\d{3,12}$/.test(id)) throw new HttpError(400, 'API ID — это число (обычно 7–8 цифр).');
    if (!/^[0-9a-f]{32}$/i.test(hash)) throw new HttpError(400, 'API hash — это 32 символа (цифры и буквы a–f).');
    await this.store.saveAppCredentials(
      await encryptSecret(this.secret, id),
      await encryptSecret(this.secret, hash.toLowerCase()),
    );
    return this.status();
  }

  async requireCreds() {
    const creds = await this.getCreds();
    if (!creds) throw new HttpError(400, 'Сначала сохраните API ID и API hash (my.telegram.org).');
    return creds;
  }

  // ---------- login flows ----------
  async beginFlow(kind) {
    await this.load();
    await this.cancelLogin(true);
    const creds = await this.requireCreds();
    const client = this.makeClient(creds, '');
    const flow = { id: ++this.flowSeq, kind, client, pw: null, code: null };
    this.flow = flow;
    this.client = client;
    this.state = 'connecting';
    this.error = null;
    this.notice = null;
    this.qr = null;
    return flow;
  }

  waitPassword(flow, hint) {
    if (this.flow !== flow) return Promise.reject(new Error('LOGIN_CANCELLED'));
    flow.pw = deferred();
    this.state = 'password_needed';
    this.passwordHint = hint || null;
    this.qr = null;
    return flow.pw.promise;
  }

  waitCode(flow) {
    if (this.flow !== flow) return Promise.reject(new Error('LOGIN_CANCELLED'));
    flow.code = deferred();
    this.state = 'code_pending';
    return flow.code.promise;
  }

  async startQr() {
    const flow = await this.beginFlow('qr');
    flow.promise = (async () => {
      try {
        this.stage = 'connect';
        await flow.client.connect();
        this.stage = 'qr';
        const me = await flow.client.loginQr({
          onQr: (qr) => { if (this.flow === flow) { this.qr = qr; this.state = 'qr_pending'; this.stage = null; this.notice = null; } },
          getPassword: (hint) => this.waitPassword(flow, hint),
          onError: (e) => { if (this.flow === flow) this.notice = describeError(e); },
        });
        await this.completeLogin(flow, me);
      } catch (e) { await this.failFlow(flow, e); }
    })();
    await this.waitFor(() => this.flow !== flow || this.state === 'qr_pending' || this.state === 'error', LOGIN_WAIT_MS);
    await this.expireFlow(flow);
    return this.status();
  }

  async startPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new HttpError(400, 'Введите номер в международном формате, например +380501234567.');
    const flow = await this.beginFlow('phone');
    flow.promise = (async () => {
      try {
        this.stage = 'connect';
        await flow.client.connect();
        this.stage = 'code';
        const me = await flow.client.loginPhone({
          phone: normalized,
          getCode: () => { this.stage = null; return this.waitCode(flow); },
          getPassword: (hint) => this.waitPassword(flow, hint),
          onError: (e) => { if (this.flow === flow) this.notice = describeError(e); },
        });
        await this.completeLogin(flow, me);
      } catch (e) { await this.failFlow(flow, e); }
    })();
    await this.waitFor(() => this.flow !== flow || this.state === 'code_pending' || this.state === 'error', LOGIN_WAIT_MS);
    await this.expireFlow(flow);
    return this.status();
  }

  /** A login step that is still "connecting" after the wait is a hang: fail it with a message that names the stage. */
  async expireFlow(flow) {
    if (this.flow !== flow || this.state !== 'connecting') return;
    await this.failFlow(flow, new Error(`LOGIN_TIMEOUT:${this.stage || 'connect'}`));
  }

  async submitCode(code) {
    const clean = String(code ?? '').replace(/\D/g, '');
    if (this.state !== 'code_pending' || !this.flow?.code) throw new HttpError(409, 'Сейчас код не запрашивается. Начните вход заново.');
    if (clean.length < 4 || clean.length > 8) throw new HttpError(400, 'Код состоит из 5–6 цифр.');
    const flow = this.flow;
    this.notice = null;
    this.state = 'connecting';
    flow.code.resolve(clean);
    await this.waitFor(() => this.state !== 'connecting', 20000);
    return this.status();
  }

  async submitPassword(password) {
    if (this.state !== 'password_needed' || !this.flow?.pw) throw new HttpError(409, 'Сейчас пароль не запрашивается.');
    const pw = String(password ?? '');
    if (!pw || pw.length > 256) throw new HttpError(400, 'Введите пароль двухфакторной защиты.');
    const flow = this.flow;
    this.notice = null;
    this.state = 'connecting';
    flow.pw.resolve(pw);
    await this.waitFor(() => this.state !== 'connecting', 20000);
    return this.status();
  }

  async completeLogin(flow, me) {
    if (this.flow !== flow) return;
    const session = await flow.client.exportSession();
    this.me = me;
    await this.store.saveAccount({
      session_enc: await encryptSecret(this.secret, session),
      me_json: JSON.stringify(me),
      status: 'connected',
      last_error: null,
    });
    this.flow = null;
    this.qr = null;
    this.error = null;
    this.notice = null;
    this.state = 'connected';
    await this.store.addLog('info', `Аккаунт подключён: ${me?.firstName || ''} ${me?.username ? '@' + me.username : ''}`.trim());
    try { this.dialogs = await this.client.listDialogs(); } catch { /* warm-up only */ }
  }

  async failFlow(flow, err) {
    if (this.flow !== flow) return; // cancelled or replaced — ignore
    this.error = describeError(err);
    this.state = 'error';
    this.stage = null;
    this.flow = null;
    this.qr = null;
    try { await flow.client.disconnect(); } catch { /* ignore */ }
    this.client = null;
    try { await this.store.saveAccount({ status: 'error', last_error: this.error }); } catch { /* ignore */ }
  }

  async cancelLogin(silent = false) {
    const flow = this.flow;
    if (!flow) return this.status();
    this.flow = null;
    this.stage = null;
    flow.pw?.reject(new Error('LOGIN_CANCELLED'));
    flow.code?.reject(new Error('LOGIN_CANCELLED'));
    try { await flow.client.disconnect(); } catch { /* ignore */ }
    if (this.client === flow.client) this.client = null;
    this.qr = null;
    const acc = await this.store.getAccount();
    this.state = acc?.session_enc ? 'disconnected' : 'logged_out';
    if (!silent) this.notice = 'Вход отменён.';
    return this.status();
  }

  // ---------- connected session ----------
  async ensureConnected() {
    await this.load();
    if (this.state === 'connected' && this.client) return this.client;
    if (this.flow) throw new HttpError(409, 'Идёт вход в аккаунт. Завершите или отмените его.');
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const acc = await this.store.getAccount();
        if (!acc?.session_enc) throw new HttpError(409, 'Аккаунт Telegram не подключён.');
        const creds = await this.requireCreds();
        const session = await decryptSecret(this.secret, acc.session_enc);
        this.state = 'connecting';
        const client = this.makeClient(creds, session);
        await client.connect();
        const me = await client.getMe();
        this.client = client;
        this.me = me;
        this.state = 'connected';
        this.error = null;
        await this.store.saveAccount({ status: 'connected', me_json: JSON.stringify(me), last_error: null });
        try { this.dialogs = await client.listDialogs(); } catch { /* cache warm-up only */ }
        return client;
      } catch (e) {
        this.client = null;
        if (FATAL_SESSION.test(errorCode(e))) await this.invalidateSession(e);
        else { this.state = 'disconnected'; this.error = e instanceof HttpError ? e.message : describeError(e); }
        throw e;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async invalidateSession(err) {
    this.state = 'logged_out';
    this.error = describeError(err);
    this.me = null;
    await this.store.saveAccount({ session_enc: null, me_json: null, status: 'logged_out', last_error: this.error });
    await this.store.saveSettings({ running: false });
    await this.scheduleAlarm(null);
    await this.store.addLog('error', this.error);
  }

  async logout() {
    await this.load();
    await this.cancelLogin(true);
    try {
      if (this.client) { await this.client.logOut(); }
    } catch { /* the session may already be dead */ }
    try { await this.client?.disconnect(); } catch { /* ignore */ }
    this.client = null;
    this.me = null;
    this.state = 'logged_out';
    this.error = null;
    this.notice = 'Вы вышли из аккаунта. Сессия удалена.';
    await this.store.saveAccount({ session_enc: null, me_json: null, status: 'logged_out', last_error: null });
    await this.store.saveSettings({ running: false });
    await this.scheduleAlarm(null);
    await this.store.addLog('info', 'Выход из аккаунта Telegram');
    return this.status();
  }

  // ---------- sources ----------
  async listDialogs() {
    const client = await this.ensureConnected();
    this.dialogs = await client.listDialogs();
    const monitored = new Map((await this.store.listSources()).map((s) => [s.id, s]));
    return this.dialogs.map((d) => ({ id: d.id, title: d.title, kind: d.kind, members: d.members ?? null, monitored: monitored.has(d.id) }));
  }

  async addSource(id) {
    const key = String(id ?? '');
    if (!/^-?\d{1,20}$/.test(key)) throw new HttpError(400, 'Некорректный идентификатор чата.');
    const client = await this.ensureConnected();
    let dialog = this.dialogs.find((d) => d.id === key);
    if (!dialog) { this.dialogs = await client.listDialogs(); dialog = this.dialogs.find((d) => d.id === key); }
    if (!dialog) throw new HttpError(404, 'Чат не найден среди диалогов аккаунта.');
    let target = { id: dialog.id, title: dialog.title };
    if (dialog.kind === 'channel') {
      const linked = await client.resolveDiscussion(dialog.id);
      if (!linked) throw new HttpError(422, 'У этого канала нет группы комментариев — читать нечего (посты канала пишет сам канал).');
      target = linked;
    }
    await this.store.addSource({ id: dialog.id, title: dialog.title, kind: dialog.kind, targetId: target.id, targetTitle: target.title });
    await this.store.addLog('info', `Добавлен источник: ${dialog.title}${dialog.kind === 'channel' ? ` (комментарии: ${target.title})` : ''}`);
    return { id: dialog.id, title: dialog.title, kind: dialog.kind, targetId: target.id, targetTitle: target.title };
  }

  async removeSource(id) {
    await this.store.removeSource(String(id));
    return { ok: true };
  }

  // ---------- monitoring ----------
  async monitorState() {
    const [settings, sources, log, leadsCount, runStats, leadPeriods, templates, planGoal, resourceTotals] = await Promise.all([
      this.store.getSettings(), this.store.listSources(), this.store.listLog(30), this.store.countLeads(), this.store.getRunStats(), this.store.getLeadPeriodCounts(), this.store.listTemplates(), this.store.getPlanGoal(), this.store.getResourcePeriodTotals(),
    ]);
    return { settings, sources, log, leadsCount, telegramState: this.state, pausedUntil: this.pausedUntil > this.now() ? this.pausedUntil : null, runStats, leadPeriods, templates, planGoal, resourceTotals };
  }

  async saveMonitorSettings(patch) {
    const clean = {};
    if (patch.keywords !== undefined) clean.keywords = String(patch.keywords).slice(0, 8000);
    if (patch.phrases !== undefined) clean.phrases = String(patch.phrases).slice(0, 8000);
    if (patch.matchMode !== undefined) { if (!['keywords','phrases','both'].includes(patch.matchMode)) throw new HttpError(400, 'Неверный режим фильтра.'); clean.matchMode = patch.matchMode; }
    if (patch.activeTemplateId !== undefined) clean.activeTemplateId = String(patch.activeTemplateId || '').slice(0,100) || null;
    clean.matchAny = false; // Legacy D1 column remains for compatibility; test-only bypass is removed.
    if (patch.intervalSeconds !== undefined) {
      const n = Math.round(Number(patch.intervalSeconds));
      if (!Number.isFinite(n) || n < 15 || n > 3600) throw new HttpError(400, 'Интервал проверки: от 15 до 3600 секунд.');
      clean.intervalSeconds = n;
    }
    if (patch.running !== undefined) clean.running = Boolean(patch.running);
    const next = await this.store.saveSettings(clean);
    if (clean.running === true) {
      if (!String(next.keywords).trim() && !String(next.phrases).trim()) {
        await this.store.saveSettings({ running: false, matchAny: false });
        throw new HttpError(400, 'Задайте ключевые слова или фразы перед запуском мониторинга.');
      }
      await this.store.startRun();
      await this.scheduleAlarm(1500);
      await this.store.addLog('info', 'Мониторинг запущен');
    } else if (clean.running === false) {
      await this.store.stopRun();
      await this.scheduleAlarm(null);
      await this.store.addLog('info', 'Мониторинг остановлен');
    }
    return next;
  }

  async processMessage(src, msg, settings, stats) {
    stats.checked += 1;
    const sender = msg.sender;
    if (!msg.text || !sender || sender.isBot) return;
    if (this.me && String(sender.id) === String(this.me.id)) return; // never harvest ourselves
    const keyword = matchTrigger(msg.text, settings);
    if (!keyword) return;
    stats.matched += 1;
    const label = src.kind === 'channel' ? `${src.title} (комментарии)` : src.title;
    const res = await this.store.recordHit({
      telegramId: String(sender.id),
      username: sender.username || null,
      firstName: sender.firstName || null,
      lastName: sender.lastName || null,
      phone: normalizePhone(sender.phone),
      sourceTitle: label,
      sourceChatId: String(src.target_id || src.id),
      messageId: msg.id,
      text: String(msg.text).slice(0, 1000),
      keyword,
      date: (typeof msg.date === 'number' || /^\d+$/.test(String(msg.date || ''))) ? new Date(Number(msg.date) * 1000).toISOString() : msg.date,
      templateId: settings.activeTemplateId || null,
      sourceId: src.id,
    });
    if (res.alreadyRecorded) stats.repeated += 1;
    else if (res.isNew) stats.newLeads += 1;
    else stats.knownLeads += 1;
  }

  async pollSource(client, src, settings, stats) {
    const target = src.target_id || src.id;
    const stamp = new Date(this.now()).toISOString();
    try {
      if (!src.baseline_done) {
        const latest = await client.fetchMessages(target, { latest: 1, parentId: src.id });
        const maxId = latest.reduce((m, x) => Math.max(m, x.id), 0);
        await this.store.updateSource(src.id, { baselineDone: true, lastMessageId: maxId, lastCheckedAt: stamp, lastError: null });
        await this.store.addLog('info', `«${src.title}»: наблюдение началось, учитываются только новые сообщения`);
        return;
      }
      let after = Number(src.last_message_id) || 0;
      let seen = 0;
      for (let page = 0; page < 3; page += 1) {
        const msgs = await client.fetchMessages(target, { afterId: after, limit: 100, parentId: src.id });
        if (!msgs.length) break;
        for (const m of msgs) await this.processMessage(src, m, settings, stats);
        after = Math.max(after, ...msgs.map((m) => m.id));
        seen += msgs.length;
        if (msgs.length < 100) break;
      }
      await this.store.updateSource(src.id, { lastMessageId: after, lastCheckedAt: stamp, lastError: null });
      if (seen) await this.store.bumpSeen(src.id, seen);
    } catch (e) {
      await this.handleSourceError(src, e);
    }
  }

  async handleSourceError(src, e) {
    const code = errorCode(e);
    if (FATAL_SESSION.test(code)) { await this.invalidateSession(e); throw e; }
    const flood = code.match(/FLOOD_WAIT_?(\d+)?/);
    if (flood || e?.seconds) {
      const sec = Number(flood?.[1] || e.seconds || 60);
      this.pausedUntil = this.now() + sec * 1000;
      await this.store.addLog('warn', `Ограничение частоты Telegram: пауза ${sec} с`);
    }
    const message = describeError(e);
    await this.store.updateSource(src.id, { lastError: message, lastCheckedAt: new Date(this.now()).toISOString() });
    await this.store.addLog('warn', `«${src.title}»: ${message}`);
  }

  newStats() { return { checked: 0, matched: 0, newLeads: 0, knownLeads: 0, repeated: 0 }; }

  /** Called by the Durable Object alarm. */
  async tick() {
    await this.load();
    const settings = await this.store.getSettings();
    if (!settings.running) return { skipped: 'not_running' };
    const stats = this.newStats();
    try {
      if (this.now() < this.pausedUntil) return { skipped: 'flood_wait' };
      const client = await this.ensureConnected();
      const sources = (await this.store.listSources()).filter((s) => s.enabled);
      for (const src of sources) {
        if (this.now() < this.pausedUntil) break;
        await this.pollSource(client, src, settings, stats);
        await this.sleep(250);
      }
      await this.store.bumpRunStats({ cycles: 1, chats: sources.length, messages: stats.checked, leads: stats.newLeads });
      if (stats.newLeads || stats.knownLeads) await this.store.addLog('info', `Проверка: найдено ${stats.matched}, новых лидов ${stats.newLeads}`);
      await this.evaluatePlanGoal();
      return stats;
    } catch (e) {
      if (!FATAL_SESSION.test(errorCode(e))) await this.store.addLog('error', e instanceof HttpError ? e.message : describeError(e));
      return { error: errorCode(e) };
    } finally {
      const after = await this.store.getSettings();
      if (after.running) {
        const wait = Math.max(after.intervalSeconds * 1000, this.pausedUntil - this.now());
        await this.scheduleAlarm(wait);
      }
    }
  }

  /** Manual test button: look at the last N messages of every source right now. */
  async runCheck({ backfill = 50 } = {}) {
    const n = Math.min(Math.max(Math.round(Number(backfill) || 50), 1), 200);
    const settings = await this.store.getSettings();
    if (!settings.matchAny && !String(settings.keywords).trim() && !String(settings.phrases).trim()) {
      throw new HttpError(400, 'Задайте ключевые слова или фразы перед проверкой.');
    }
    const client = await this.ensureConnected();
    const sources = (await this.store.listSources()).filter((s) => s.enabled);
    if (!sources.length) throw new HttpError(400, 'Сначала добавьте хотя бы один источник.');
    const stats = this.newStats();
    const perSource = [];
    for (const src of sources) {
      const target = src.target_id || src.id;
      const before = { ...stats };
      try {
        const msgs = await client.fetchMessages(target, { latest: n, parentId: src.id });
        for (const m of msgs) await this.processMessage(src, m, settings, stats);
        const maxId = msgs.reduce((m, x) => Math.max(m, x.id), Number(src.last_message_id) || 0);
        await this.store.updateSource(src.id, { baselineDone: true, lastMessageId: Math.max(maxId, Number(src.last_message_id) || 0), lastCheckedAt: new Date(this.now()).toISOString(), lastError: null });
        perSource.push({ title: src.title, read: msgs.length, matched: stats.matched - before.matched, newLeads: stats.newLeads - before.newLeads });
      } catch (e) {
        await this.handleSourceError(src, e);
        perSource.push({ title: src.title, error: describeError(e) });
      }
      await this.sleep(250);
    }
    await this.store.addLog('info', `Ручная проверка (последние ${n}): прочитано ${stats.checked}, совпало ${stats.matched}, новых лидов ${stats.newLeads}`);
    await this.evaluatePlanGoal();
    return { ...stats, perSource };
  }

  async saveFilterTemplate(payload) {
    const name=String(payload?.name||'').trim().slice(0,80); if(!name) throw new HttpError(400,'Введите название шаблона.');
    const settings=await this.store.getSettings();
    const t={id:String(payload.id||crypto.randomUUID()),name,keywords:String(payload.keywords??settings.keywords).slice(0,8000),phrases:String(payload.phrases??settings.phrases).slice(0,8000),matchMode:payload.matchMode??settings.matchMode,matchAny:Boolean(payload.matchAny??settings.matchAny),intervalSeconds:Math.max(15,Math.min(3600,Number(payload.intervalSeconds??settings.intervalSeconds)||30))};
    await this.store.saveTemplate(t); return this.store.listTemplates();
  }
  async deleteFilterTemplate(id) { await this.store.deleteTemplate(String(id)); const s=await this.store.getSettings(); if(s.activeTemplateId===String(id)) await this.store.saveSettings({activeTemplateId:null}); return this.store.listTemplates(); }
  async applyFilterTemplate(id) {
    const list=await this.store.listTemplates(); const t=list.find(x=>x.id===String(id)); if(!t) throw new HttpError(404,'Шаблон не найден.');
    const next=await this.store.saveSettings({keywords:t.keywords,phrases:t.phrases,matchMode:t.matchMode,matchAny:t.matchAny,intervalSeconds:t.intervalSeconds,activeTemplateId:t.id});
    return next;
  }
  async savePlanGoal(payload) {
    const contact=String(payload.contactUsername||'').trim(); if(contact && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(contact)) throw new HttpError(400,'Контакт должен быть Telegram-ником в формате @username.');
    const target=Math.max(0,Math.min(1000000,Math.round(Number(payload.targetLeads)||0)));
    const existing=await this.store.getPlanGoal();
    return this.store.savePlanGoal({targetLeads:target,templateId:payload.templateId||null,sourceId:payload.sourceId||null,enabled:target>0,notified:false,contactUsername:contact||existing?.contact_username||''});
  }
  async savePlanContact(payload) { const username=String(payload.username||'').trim(); if(username && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new HttpError(400,'Контакт должен быть Telegram-ником в формате @username.'); return this.store.savePlanContact(username); }
  async evaluatePlanGoal() {
    const goal=await this.store.getPlanGoal(); if(!goal||!goal.enabled||goal.notified||!goal.target_leads) return false;
    const count=await this.store.countGoalLeads({templateId:goal.template_id,sourceId:goal.source_id}); if(count<goal.target_leads) return false;
    await this.store.savePlanGoal({...goal,targetLeads:goal.target_leads,templateId:goal.template_id,sourceId:goal.source_id,enabled:true,notified:true,contactUsername:goal.contact_username});
    const message=`План по лидам ${goal.target_leads} — ЗАКРЫТ. Проверьте базу, и сделайте выгрузку.`;
    const username=goal.contact_username;
    if(username && this.state==='connected' && this.client?.sendMessage) { try { await this.client.sendMessage(username,message); await this.store.addLog('info','План закрыт — уведомление отправлено контакту '+username); } catch(e) { await this.store.addLog('warn','План закрыт, но уведомление не отправлено: '+describeError(e)); } }
    else await this.store.addLog('info','План по лидам закрыт. Проверьте базу и выгрузку.');
    return true;
  }

  async runDiagnostics() {
    const creds = await this.getCreds();
    if (!this.diagnose) return { steps: [{ name: 'diagnose', ok: false, detail: 'not_available' }] };
    return this.diagnose({ creds });
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
