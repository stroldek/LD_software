# CHANGELOG

## 1.5.0 — 2026-11-24

### Added
- Filter templates with separate keyword/phrase fields and `keywords`, `phrases`, `both` modes.
- Date of the triggering Telegram message is shown in the leads table and Excel export.
- Password re-confirmation (`ADMIN_TOKEN`) for lead database deletion.
- Overview dashboards for current monitor run, lead counts, conversion, and activity estimates.
- Plan goal with optional template/source scope and a single Telegram notification to configured `@username` on completion.
- Journal moved to its own navigation page.
- ZAMOVO/LEAD transparent logo in sidebar.
- Potential source shortlist with category mix and batch addition to monitoring.
- D1 migration 0004 and tests for phrase matching, filter templates, run counters and goal notification.

### Limitations
- Telegram global thematic search is not implemented; shortlist only searches dialogs available to the connected account.
- Automatic joining/subscribing to communities is not implemented. Users choose sources and add them to monitoring manually.
- Cloudflare billing counters are not exposed directly in the application; exact rows read/written and CPU usage are available in Cloudflare Analytics.

## 0.1.4 — 2026-11-23
- Fixed Telegram WSS hostname routing for MTProto in Cloudflare Workers.
- Separated application API credentials from the personal-account session.
- Removed Telegram Bot API routes, webhook setup and bot persistence.
- Added D1 migration 0003 and automated package build.

## 0.1.3 — 2026-11-23
- QR and phone login timeout handling, diagnostics and cancellation.

## 0.1.2 — 2026-11-22
- Personal Telegram login via QR/phone, encrypted session, monitoring of chosen chats, lead database and Excel export.

## 0.1.1 — 2026-11-12
- Local preview and launcher.
