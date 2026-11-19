# Changelog

## 0.2.0 — 2026-11-19

- Added personal Telegram account authorization through MTProto using the maintained `teleproto` client.
- Added phone number, Telegram login code and optional 2FA password flow.
- Added a dedicated Telegram screen in the workspace.
- Added encrypted AES-GCM storage for MTProto session and pending authorization state in D1.
- Derived the session encryption key from Cloudflare secrets; no additional secret or database migration is required.
- Added protected API endpoints for Telegram status, code request, sign-in, 2FA and disconnect.
- Added Cloudflare deployment and secret setup instructions.
- Explicitly excluded Telegram Bot API, bot tokens and BotFather.

### Not included yet

- Reading or collecting users from dialogs, groups or channels.
- Participant collection workflows.
- XLSX import/export.
- Consent-aware communication workflow and chat queue controls.
- Backup/restore automation and multi-user roles.

## 0.1.0 — 2026-11-19

- Created a clean repository-root Cloudflare Workers + Static Assets project.
- Added initial D1 schema for leads, segments, memberships, search jobs, chat queue/history, settings and audit log.
- Added admin-token API authentication and health endpoint.
- Added dashboard statistics, paginated lead listing, lead create/update/delete, segment create/update/delete and segment membership API.
- Added initial responsive admin interface for login, dashboard, leads and segments.
- Added Cloudflare deployment instructions and baseline unit tests.
