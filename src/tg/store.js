// D1 repository for the Telegram test layer. All SQL lives here (adapter boundary for a future PostgreSQL swap).
import { normalizeText } from '../lib/triggers.js';

const nowIso = () => new Date().toISOString();

export function createStore(db) {
  return {
    // ---- account ----
    async getAccount() {
      return (await db.prepare('SELECT * FROM tg_account WHERE id = 1').first()) || null;
    },
    // Application credentials are global to the software, not tied to a Telegram account session.
    async getAppCredentials() {
      return (await db.prepare('SELECT api_id_enc, api_hash_enc FROM tg_app_credentials WHERE id = 1').first()) || null;
    },
    async saveAppCredentials(apiIdEnc, apiHashEnc) {
      const now = nowIso();
      await db.prepare(`INSERT INTO tg_app_credentials (id, api_id_enc, api_hash_enc, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET api_id_enc = excluded.api_id_enc,
          api_hash_enc = excluded.api_hash_enc, updated_at = excluded.updated_at`)
        .bind(apiIdEnc, apiHashEnc, now).run();
    },
    async saveAccount(fields) {
      const allowed = ['session_enc', 'status', 'me_json', 'last_error'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      await db.prepare('INSERT OR IGNORE INTO tg_account (id) VALUES (1)').run();
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE tg_account SET ${sets}, updated_at = ? WHERE id = 1`)
        .bind(...keys.map((k) => fields[k]), nowIso()).run();
    },

    // ---- settings ----
    async getSettings() {
      const row = await db.prepare('SELECT * FROM monitor_settings WHERE id = 1').first();
      return {
        keywords: row?.keywords ?? '',
        phrases: row?.phrases ?? '',
        matchMode: row?.match_mode ?? 'keywords',
        activeTemplateId: row?.active_template_id ?? null,
        matchAny: Boolean(row?.match_any),
        intervalSeconds: Number(row?.interval_seconds ?? 30),
        running: Boolean(row?.running),
      };
    },
    async saveSettings(patch) {
      await db.prepare('INSERT OR IGNORE INTO monitor_settings (id) VALUES (1)').run();
      const cur = await this.getSettings();
      const next = { ...cur, ...patch };
      await db.prepare(`UPDATE monitor_settings SET keywords = ?, phrases = ?, match_mode = ?, active_template_id = ?, match_any = ?, interval_seconds = ?, running = ?, updated_at = ? WHERE id = 1`)
        .bind(String(next.keywords).slice(0, 8000), String(next.phrases || '').slice(0, 8000), ['keywords','phrases','both'].includes(next.matchMode) ? next.matchMode : 'keywords', next.activeTemplateId || null, next.matchAny ? 1 : 0, next.intervalSeconds, next.running ? 1 : 0, nowIso()).run();
      return next;
    },

    // ---- filter templates ----
    async listTemplates() {
      const { results } = await db.prepare('SELECT id, name, keywords, phrases, match_mode AS matchMode, match_any AS matchAny, interval_seconds AS intervalSeconds, created_at, updated_at FROM filter_templates ORDER BY name COLLATE NOCASE').all();
      return (results || []).map((r) => ({ ...r, matchAny: Boolean(r.matchAny), intervalSeconds: Number(r.intervalSeconds) }));
    },
    async saveTemplate(t) {
      const now = nowIso();
      await db.prepare(`INSERT INTO filter_templates (id, name, keywords, phrases, match_mode, match_any, interval_seconds, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, keywords=excluded.keywords, phrases=excluded.phrases, match_mode=excluded.match_mode, match_any=excluded.match_any, interval_seconds=excluded.interval_seconds, updated_at=excluded.updated_at`)
        .bind(t.id, t.name, String(t.keywords || '').slice(0,8000), String(t.phrases || '').slice(0,8000), t.matchMode || 'keywords', t.matchAny ? 1 : 0, t.intervalSeconds || 30, now, now).run();
      return t;
    },
    async deleteTemplate(id) { await db.prepare('DELETE FROM filter_templates WHERE id = ?').bind(id).run(); },
    // ---- monitoring-run counters ----
    async getRunStats() { return (await db.prepare('SELECT * FROM monitoring_run_stats WHERE id = 1').first()) || { started_at:null, stopped_at:null, cycles:0, chats_processed:0, messages_processed:0, leads_generated:0 }; },
    async startRun() { const now=nowIso(); const res=await db.prepare('INSERT INTO monitoring_runs (started_at) VALUES (?)').bind(now).run(); const runId=Number(res.meta?.last_row_id||0); await db.prepare(`UPDATE monitoring_run_stats SET run_id=?, started_at=?, stopped_at=NULL, cycles=0, chats_processed=0, messages_processed=0, leads_generated=0 WHERE id=1`).bind(runId,now).run(); },
    async stopRun() { const now=nowIso(); const current=await this.getRunStats(); await db.prepare('UPDATE monitoring_run_stats SET stopped_at=? WHERE id=1').bind(now).run(); if(current.run_id) await db.prepare('UPDATE monitoring_runs SET stopped_at=? WHERE id=?').bind(now,current.run_id).run(); },
    async bumpRunStats({cycles=0,chats=0,messages=0,leads=0}={}) { const current=await this.getRunStats(); await db.prepare(`UPDATE monitoring_run_stats SET cycles=cycles+?, chats_processed=chats_processed+?, messages_processed=messages_processed+?, leads_generated=leads_generated+? WHERE id=1`).bind(cycles,chats,messages,leads).run(); if(current.run_id) await db.prepare(`UPDATE monitoring_runs SET cycles=cycles+?, chats_processed=chats_processed+?, messages_processed=messages_processed+?, leads_generated=leads_generated+? WHERE id=?`).bind(cycles,chats,messages,leads,current.run_id).run(); },
    async getResourcePeriodTotals() { const now=new Date(); const today=new Date(now); today.setHours(0,0,0,0); const week=new Date(now); week.setDate(week.getDate()-7); const [t,w]=await Promise.all([db.prepare('SELECT COALESCE(SUM(cycles),0) cycles, COALESCE(SUM(chats_processed),0) chats, COALESCE(SUM(messages_processed),0) messages, COALESCE(SUM(leads_generated),0) leads FROM monitoring_runs WHERE datetime(started_at)>=datetime(?)').bind(today.toISOString()).first(),db.prepare('SELECT COALESCE(SUM(cycles),0) cycles, COALESCE(SUM(chats_processed),0) chats, COALESCE(SUM(messages_processed),0) messages, COALESCE(SUM(leads_generated),0) leads FROM monitoring_runs WHERE datetime(started_at)>=datetime(?)').bind(week.toISOString()).first()]); return {today:t,week:w}; },
    async getPlanGoal() { return (await db.prepare('SELECT * FROM plan_goal WHERE id=1').first()) || null; },
    async savePlanContact(username) { await db.prepare('UPDATE plan_goal SET contact_username=? WHERE id=1').bind(String(username||'').slice(0,32)).run(); return this.getPlanGoal(); },
    async savePlanGoal(g) { await db.prepare(`UPDATE plan_goal SET target_leads=?, template_id=?, source_id=?, enabled=?, notified=?, contact_username=? WHERE id=1`).bind(Math.max(0,Math.min(1000000,Number(g.targetLeads)||0)),g.templateId||null,g.sourceId||null,g.enabled?1:0,g.notified?1:0,String(g.contactUsername||'').slice(0,32)).run(); return this.getPlanGoal(); },
    async getLeadPeriodCounts() { const now=new Date(); const today=new Date(now); today.setHours(0,0,0,0); const week=new Date(now); week.setDate(week.getDate()-7); const month=new Date(now); month.setDate(month.getDate()-30); const [t,w,m]=await Promise.all([db.prepare('SELECT COUNT(*) n FROM leads WHERE datetime(created_at)>=datetime(?)').bind(today.toISOString()).first(),db.prepare('SELECT COUNT(*) n FROM leads WHERE datetime(created_at)>=datetime(?)').bind(week.toISOString()).first(),db.prepare('SELECT COUNT(*) n FROM leads WHERE datetime(created_at)>=datetime(?)').bind(month.toISOString()).first()]); return {today:Number(t?.n||0),week:Number(w?.n||0),month:Number(m?.n||0),total:await this.countLeads()}; },
    // ---- sources ----
    async listSources() {
      const { results } = await db.prepare('SELECT * FROM monitor_sources ORDER BY created_at, id').all();
      return results || [];
    },
    async getSource(id) {
      return (await db.prepare('SELECT * FROM monitor_sources WHERE id = ?').bind(id).first()) || null;
    },
    async addSource(src) {
      await db.prepare(`INSERT INTO monitor_sources (id, title, kind, target_id, target_title, enabled, baseline_done, last_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, target_id = excluded.target_id, target_title = excluded.target_title, enabled = 1`)
        .bind(src.id, src.title, src.kind, src.targetId ?? null, src.targetTitle ?? null, nowIso()).run();
    },
    async removeSource(id) {
      await db.prepare('DELETE FROM monitor_sources WHERE id = ?').bind(id).run();
    },
    async updateSource(id, patch) {
      const map = { baselineDone: 'baseline_done', lastMessageId: 'last_message_id', lastCheckedAt: 'last_checked_at', lastError: 'last_error', enabled: 'enabled' };
      const keys = Object.keys(patch).filter((k) => map[k]);
      if (!keys.length) return;
      const sets = keys.map((k) => `${map[k]} = ?`).join(', ');
      await db.prepare(`UPDATE monitor_sources SET ${sets} WHERE id = ?`)
        .bind(...keys.map((k) => (typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k])), id).run();
    },
    async bumpSeen(id, n) {
      await db.prepare('UPDATE monitor_sources SET messages_seen = messages_seen + ? WHERE id = ?').bind(n, id).run();
    },

    // ---- log ----
    async addLog(level, message) {
      await db.prepare('INSERT INTO monitor_log (at, level, message) VALUES (?, ?, ?)').bind(nowIso(), level, String(message).slice(0, 500)).run();
      await db.prepare('DELETE FROM monitor_log WHERE id <= (SELECT MAX(id) FROM monitor_log) - 200').run();
    },
    async listLog(limit = 40) {
      const { results } = await db.prepare('SELECT at, level, message FROM monitor_log ORDER BY id DESC LIMIT ?').bind(limit).all();
      return results || [];
    },

    // ---- leads ----
    /**
     * Idempotent: the same (chat, message) can be recorded any number of times.
     * Returns { isNew, alreadyRecorded }.
     */
    async recordHit(hit) {
      const existing = await db.prepare('SELECT id FROM leads WHERE telegram_id = ?').bind(hit.telegramId).first();
      const already = await db.prepare('SELECT 1 AS x FROM lead_hits WHERE source_chat_id = ? AND message_id = ?').bind(hit.sourceChatId, hit.messageId).first();
      const now = nowIso();
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO lead_hits (source_chat_id, message_id, telegram_id, keyword, message_text, message_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(hit.sourceChatId, hit.messageId, hit.telegramId, hit.keyword, hit.text, hit.date, now),
        db.prepare(`INSERT INTO leads (id, telegram_id, username, first_name, last_name, source, quality, status, consent_status,
            phone, source_title, source_chat_id, trigger_text, trigger_keyword, trigger_message_id, trigger_message_date, filter_template_id, source_id_for_goal, hits_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'telegram_monitor', 'unclassified', 'new', 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(telegram_id) DO UPDATE SET
            username = COALESCE(excluded.username, leads.username),
            first_name = COALESCE(excluded.first_name, leads.first_name),
            last_name = COALESCE(excluded.last_name, leads.last_name),
            phone = COALESCE(excluded.phone, leads.phone),
            hits_count = (SELECT COUNT(*) FROM lead_hits WHERE telegram_id = excluded.telegram_id),
            updated_at = excluded.updated_at`)
          .bind(crypto.randomUUID(), hit.telegramId, hit.username, hit.firstName, hit.lastName, hit.phone,
            hit.sourceTitle, hit.sourceChatId, hit.text, hit.keyword, hit.messageId, hit.date, hit.templateId || null, hit.sourceId || null, now, now),
      ]);
      // Rebuild the search copy from the merged row (a returning person may have gained a username or phone).
      const row = await db.prepare('SELECT first_name, last_name, username, phone, source_title, trigger_text FROM leads WHERE telegram_id = ?').bind(hit.telegramId).first();
      if (row) {
        const norm = normalizeText([hit.telegramId, row.first_name, row.last_name, row.username, row.phone, row.source_title, row.trigger_text].filter(Boolean).join(' '));
        await db.prepare('UPDATE leads SET search_norm = ? WHERE telegram_id = ?').bind(norm, hit.telegramId).run();
      }
      return { isNew: !existing, alreadyRecorded: Boolean(already) };
    },

    async listLeads({ q = '', limit = 25, offset = 0 } = {}) {
      const where = [];
      const args = [];
      const term = normalizeText(String(q || '').slice(0, 100));
      if (term) {
        where.push(`search_norm LIKE ? ESCAPE '\\'`);
        args.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.prepare(`SELECT COUNT(*) AS n FROM leads ${clause}`).bind(...args).first();
      const { results } = await db.prepare(`SELECT telegram_id, username, first_name, last_name, phone, source_title, trigger_text, trigger_keyword, trigger_message_date, hits_count, created_at
          FROM leads ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
      return { total: Number(total?.n ?? 0), rows: results || [] };
    },
    /** Keyset pagination by rowid so large exports never use deep OFFSET. */
    async leadsBatch(afterRowid, limit = 500) {
      const { results } = await db.prepare(`SELECT rowid AS rid, telegram_id, username, first_name, last_name, phone, source_title, trigger_text, trigger_message_date, created_at
          FROM leads WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(afterRowid, limit).all();
      return results || [];
    },
    async countLeads() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM leads').first();
      return Number(row?.n ?? 0);
    },
    async countGoalLeads({templateId=null,sourceId=null}={}) { const clauses=[]; const args=[]; if(sourceId){clauses.push('source_chat_id=?');args.push(sourceId);} if(templateId){clauses.push('filter_template_id=?');args.push(templateId);} const row=await db.prepare(`SELECT COUNT(*) AS n FROM leads ${clauses.length?'WHERE '+clauses.join(' AND '):''}`).bind(...args).first(); return Number(row?.n||0); },
    async clearLeads() {
      await db.batch([db.prepare('DELETE FROM lead_hits'), db.prepare('DELETE FROM leads')]);
    },
  };
}
