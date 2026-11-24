-- 1.5.0: filter templates, phrase matching, monitoring-run metrics, plan goals and message date.
ALTER TABLE monitor_settings ADD COLUMN phrases TEXT NOT NULL DEFAULT '';
ALTER TABLE monitor_settings ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'keywords';
ALTER TABLE monitor_settings ADD COLUMN active_template_id TEXT;
ALTER TABLE leads ADD COLUMN trigger_message_date TEXT;
ALTER TABLE leads ADD COLUMN filter_template_id TEXT;
ALTER TABLE leads ADD COLUMN source_id_for_goal TEXT;

CREATE TABLE IF NOT EXISTS filter_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  phrases TEXT NOT NULL DEFAULT '',
  match_mode TEXT NOT NULL DEFAULT 'keywords' CHECK (match_mode IN ('keywords','phrases','both')),
  match_any INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitoring_run_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT,
  stopped_at TEXT,
  cycles INTEGER NOT NULL DEFAULT 0,
  chats_processed INTEGER NOT NULL DEFAULT 0,
  messages_processed INTEGER NOT NULL DEFAULT 0,
  leads_generated INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO monitoring_run_stats (id) VALUES (1);

CREATE TABLE IF NOT EXISTS plan_goal (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_leads INTEGER NOT NULL DEFAULT 0,
  template_id TEXT,
  source_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  contact_username TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO plan_goal (id) VALUES (1);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('0004_dashboard_templates_phrases');
ALTER TABLE monitoring_run_stats ADD COLUMN run_id INTEGER;
CREATE TABLE IF NOT EXISTS monitoring_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  cycles INTEGER NOT NULL DEFAULT 0,
  chats_processed INTEGER NOT NULL DEFAULT 0,
  messages_processed INTEGER NOT NULL DEFAULT 0,
  leads_generated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_monitoring_runs_started_at ON monitoring_runs(started_at);
