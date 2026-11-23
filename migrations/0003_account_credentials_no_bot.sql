-- 0.1.4: remove the unused Bot API prototype and separate app credentials from account authorization.
-- Existing encrypted API ID/hash values are migrated before their legacy columns are cleared.
CREATE TABLE IF NOT EXISTS tg_app_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_id_enc TEXT NOT NULL,
  api_hash_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO tg_app_credentials (id, api_id_enc, api_hash_enc, updated_at)
SELECT 1, api_id_enc, api_hash_enc, updated_at
  FROM tg_account
 WHERE id = 1
   AND api_id_enc IS NOT NULL
   AND api_hash_enc IS NOT NULL;

UPDATE tg_account
   SET api_id_enc = NULL,
       api_hash_enc = NULL
 WHERE id = 1;

-- Bot webhook data is not part of the product. Lead records are kept.
DROP TABLE IF EXISTS consent_events;
DROP TABLE IF EXISTS telegram_updates;
UPDATE leads
   SET source = 'telegram_account_monitor'
 WHERE source = 'telegram_bot';

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('0003_account_credentials_no_bot');
