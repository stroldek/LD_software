# Telegram integration: supported user-account model

**Версия:** 0.1.4 · **Дата:** 23.11.2026

## 1. Chosen integration

The product connects a regular Telegram user account through MTProto using GramJS. No Telegram bot is part of the product.

The application uses:
- Telegram API ID and API Hash from `my.telegram.org` — application credentials.
- The user's chosen personal Telegram account — authorizes separately through QR or phone number, code and optional 2FA password.
- An encrypted MTProto session — stored server-side in D1 and managed by the `TG` Durable Object.

## 2. Application credentials and account identity

API ID and API Hash identify the registered API application. They do not identify the Telegram account being connected.

One application key pair can be used to authenticate different personal Telegram accounts. Each successful login creates an account-specific MTProto session. In the current product, one Telegram account is connected at a time.

Storage is split:
- `tg_app_credentials`: encrypted application API ID and API Hash.
- `tg_account`: encrypted user session, connection state and minimal account profile.

Logging out clears the user session, but does not delete application credentials. The keys are not returned to the browser.

For backward compatibility, migration `0003_account_credentials_no_bot.sql` moves encrypted keys from the old `tg_account` columns to `tg_app_credentials` before clearing the old fields.

## 3. Login flows

Primary flow: QR authorization.
1. The Worker starts the Telegram client in the Durable Object.
2. GramJS obtains an MTProto login token.
3. The browser renders the `tg://login?token=...` QR code.
4. The user scans it in Telegram → Settings → Devices → Link Desktop Device.
5. The resulting authorized session is encrypted and stored in D1.

Alternative flow: phone number, Telegram code and optional two-step verification password. Both flows use the same connected personal account and session storage.

## 4. Cloudflare Workers WSS transport

Cloudflare Workers do not expose `window`, so GramJS classifies this runtime as Node. Its default DC resolver can therefore choose a direct IP address even though this integration uses WebSockets over TLS.

The application explicitly maps Telegram DC IDs to Telegram web hostnames for WSS:

| DC | Host |
|---:|---|
| 1 | `pluto.web.telegram.org` |
| 2 | `venus.web.telegram.org` |
| 3 | `aurora.web.telegram.org` |
| 4 | `vesta.web.telegram.org` |
| 5 | `flora.web.telegram.org` |

The same resolver is used for restored sessions, DC migration and download DC requests. The initial unauthenticated session starts on DC4. The diagnostic WebSocket and MTProto probe use DC4 as well.

This change addresses the known failure mode in which a WebSocket constructor opens but the first MTProto request (`GetNearestDc`) never completes because the transport selected an IP-based endpoint.

## 5. Supported data collection and boundaries

The monitor reads messages from groups, supergroups and channel discussion groups that are already available to the connected account and explicitly selected by the application owner.

It does not:
- provide a global Telegram user search;
- scrape arbitrary users or private chats the account cannot access;
- bypass membership, privacy or Telegram API restrictions;
- send unsolicited messages or automate cold outreach.

Only information available through Telegram for the connected account is collected. Phone numbers may be absent because Telegram privacy settings restrict visibility; the product does not bypass those settings.

The current build is a read-only monitor. Sending messages, changing profiles and the future auto-chat queue are not enabled in this version.

## 6. Diagnostics and verification boundary

The Diagnostics screen checks, in order:
1. Worker admin token and encryption secret.
2. Durable Object binding.
3. D1 schema including migration 0003.
4. GramJS module loading.
5. WSS connection to the DC4 hostname.
6. MTProto encrypted handshake using `help.getNearestDc`.
7. QR-token export.

A successful generic WebSocket handshake is not proof that MTProto works. The MTProto and QR-token checks must also pass.

Unit tests verify endpoint selection, login state handling, session encryption and database migration. They do not prove that an actual deployed Cloudflare Worker can complete a live Telegram login. That final acceptance check must be run in the deployed environment using the user's application credentials.
