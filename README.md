# ZAMOVO — Telegram Lead Workspace

Cloudflare Workers + Static Assets + D1 application for managing a Telegram lead database.

## Current milestone

**0.2.0 — Personal Telegram MTProto authorization**

- Existing admin-token protected workspace and D1 database.
- Personal Telegram account authorization using MTProto (phone number, Telegram login code and optional 2FA password).
- Telegram session is encrypted with AES-GCM before storage in D1.
- Telegram API credentials are read only from Cloudflare Worker secrets.
- Telegram Bot API and bot-token authorization are not used.
- The account login is a foundation for future source/chat features; this release does not yet collect channel participants or send messages.

## Cloudflare setup

See [DEPLOYMENT.md](./DEPLOYMENT.md). Repository root is the Worker root directory.

Required Worker secrets:
- `ADMIN_TOKEN` — admin password.
- `API_ID` — numeric Telegram application ID from https://my.telegram.org.
- `API_HASH` — Telegram application hash from https://my.telegram.org.

D1 binding:
- Binding name: `DB`
- Database: `zamovo-db`

The MTProto session is encrypted using a key derived from `ADMIN_TOKEN` and `API_HASH`. Do not rotate either secret while a Telegram session is saved. If either secret is rotated, disconnect/re-authorize the Telegram account. Never publish these values or the session string.

## Development

Node.js is needed only for development checks, not for normal use of the deployed web app.

```bash
npm install
npm test
```

## Product constraints

- Only personal Telegram accounts through MTProto are supported.
- No Bot API, bot token or BotFather setup.
- Telegram account login does not grant access to chats the account cannot access.
- No arbitrary global user search, anti-spam evasion, or unsolicited automated messaging.
- Any later collection or messaging feature must respect Telegram limits, applicable law, and consent requirements.
