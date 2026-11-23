# Миграции

Выполняются по порядку в D1 → Console, **каждая один раз**.

- `0001_stage1_prototype.sql` — базовые таблицы этапа 1.
- `0002_live_telegram_test.sql` — аккаунт Telegram, источники мониторинга, настройки, журнал, дополнительные поля лидов. Повторный запуск выдаст ошибку «duplicate column» — это нормально: значит, миграция уже применена.
- `../docs/FUTURE_SCHEMA.sql` — справочная схема будущих этапов. **Не запускать.**

Применённые файлы не редактируются; новые изменения добавляются файлами `0003_...sql` и далее.

### 0003 — account credentials and bot removal

Apply `0003_account_credentials_no_bot.sql` once after migrations 0001 and 0002. It creates `tg_app_credentials`, moves existing encrypted `api_id` / `api_hash` values from `tg_account`, clears the old columns, removes Bot API consent/update tables, and preserves existing lead rows.
