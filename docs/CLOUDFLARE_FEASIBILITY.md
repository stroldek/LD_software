# Cloudflare: текущая конфигурация и развёртывание

**Версия:** 0.1.4 · **Дата:** 23.11.2026

## 1. Компоненты

| Компонент | Назначение |
|---|---|
| Cloudflare Workers | REST API и серверная логика |
| Workers Static Assets | Frontend в одной публикации с Worker |
| Durable Objects | Один долгоживущий процесс Telegram user-session |
| D1 | Лиды, параметры мониторинга, API credentials и зашифрованная MTProto session |

Интеграция Telegram использует GramJS и MTProto от имени личного аккаунта пользователя. Bot API и Telegram webhook endpoints в продукте не используются.

## 2. Переменные и secrets

Обязательные secrets Worker:

| Имя | Назначение |
|---|---|
| `ADMIN_TOKEN` | Пароль входа в web-панель; минимум 20 символов |
| `APP_SECRET` | AES-GCM шифрование ключей и Telegram session; минимум 24 символа |

Необязательные secrets:

| Имя | Назначение |
|---|---|
| `TELEGRAM_API_ID` | API ID приложения с `my.telegram.org` |
| `TELEGRAM_API_HASH` | API Hash того же приложения |

API ID и API Hash можно не задавать в Cloudflare: их можно сохранить через экран «Аккаунт Telegram». Тогда они хранятся в D1 зашифрованными. Эти ключи идентифицируют приложение, а не личный аккаунт, который будет подключён через QR/номер.

Не создавать и не передавать в приложение Bot API token или webhook secrets.

## 3. D1 и миграции

В `wrangler.jsonc` проверьте, что binding `DB` указывает на нужную D1 database.

Для новой базы выполнить по порядку, каждый файл один раз:
1. `migrations/0001_stage1_prototype.sql`
2. `migrations/0002_live_telegram_test.sql`
3. `migrations/0003_account_credentials_no_bot.sql`

Для существующей базы, где 0001 и 0002 уже применены, выполнить только 0003.

Миграция 0003:
- создаёт таблицу `tg_app_credentials`;
- переносит туда старые зашифрованные ключи из `tg_account`;
- очищает прежние колонки API ID / API Hash;
- удаляет неиспользуемые таблицы `consent_events` и `telegram_updates`;
- оставляет user-session, сведения об аккаунте и лиды.

Повторно выполнять миграцию 0002 нельзя: она содержит `ALTER TABLE ADD COLUMN`.

## 4. Durable Object

Binding `TG` должен быть указан в `wrangler.jsonc` и направлен на класс Durable Object `TelegramSession`. Экземпляр `main` хранит состояние единственной активной user-session.

D1 является долговременным хранилищем. Durable Object держит активный GramJS client в памяти; после перезапуска он восстанавливает зашифрованную session из D1.

## 5. Публикация

Репозиторий подключается к Cloudflare Workers Builds. При публикации Cloudflare устанавливает зависимости и собирает проект в удалённой среде. Локальная установка Node.js, Python, Docker или Wrangler для обычного использования не требуется.

Перед публикацией:
- проверьте D1 ID в `wrangler.jsonc`;
- проверьте D1 binding `DB`;
- проверьте Durable Object binding и миграции DO;
- задайте `ADMIN_TOKEN` и `APP_SECRET`;
- примените D1 SQL migrations 0001–0003.

## 6. Диагностика Telegram

В приложении откройте «Аккаунт Telegram» → «Диагностика».

Проверки включают:
- ADMIN_TOKEN и APP_SECRET;
- Durable Object binding;
- наличие таблицы `tg_app_credentials` (миграция 0003);
- импорт GramJS;
- WebSocket over TLS к `vesta.web.telegram.org` (DC4);
- MTProto handshake через `help.getNearestDc`;
- экспорт QR login token.

Успешный WebSocket handshake не означает, что MTProto уже работает. Критерий транспортной проверки — успешный ответ от MTProto RPC.

## 7. Сетевой транспорт MTProto

В Cloudflare Worker библиотека GramJS классифицирует runtime как Node, поскольку отсутствует `window`. Без дополнительной настройки она может выбирать IP адреса Telegram DC.

Приложение 0.1.4 переопределяет resolver GramJS и для всех WSS соединений использует доменные адреса DC: `pluto`, `venus`, `aurora`, `vesta`, `flora.web.telegram.org`. При переходе на другой DC или восстановлении сессии применяется тот же механизм.

## 8. Ссылки на документацию Cloudflare

- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Static Assets: https://developers.cloudflare.com/workers/static-assets/
- D1 getting started: https://developers.cloudflare.com/d1/get-started/
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
