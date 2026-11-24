# D1 migrations

Run each migration once, in sequence for a new database.

1. `0001_stage1_prototype.sql` — original lead schema.
2. `0002_live_telegram_test.sql` — personal Telegram account, sources, monitor settings, hit tracking.
3. `0003_account_credentials_no_bot.sql` — separates app credentials from the user session; removes Bot API persistence.
4. `0004_dashboard_templates_phrases.sql` — phrase filter mode, template storage, run metrics/history, plan goal/contact, and message-date/attribution columns.

## Existing database v0.1.4

If 0001–0003 are already applied, execute **only** `0004_dashboard_templates_phrases.sql` once in D1 → SQL Console. It preserves existing leads, account and session.

Migration 0004 is not idempotent (ALTER TABLE statements). Do not run it twice.

`../docs/FUTURE_SCHEMA.sql` is a future reference schema, not a migration.
