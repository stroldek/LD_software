# Cloudflare deployment and Free-tier sizing — 1.5.0

## Free limits (checked 2026-11-24)

| Product | Free limit |
|---|---:|
| Workers requests | 100,000/day |
| CPU per request | 10 ms |
| D1 row reads | 5,000,000/day |
| D1 row writes | 100,000/day |
| D1 size per database | 500 MB |
| D1 total account storage | 5 GB |
| D1 databases | 10 |
| D1 queries per Worker invocation | 50 |

See official documentation: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Approximate lead capacity

Each matched message performs roughly:
- one insert into `lead_hits`;
- one insert/update into `leads`;
- one update to the normalized searchable text.

That is approximately 3 D1 rows written per match, before indexes, monitor settings, sources, run counters and journal writes. The theoretical ceiling by the 100,000 rows-written quota is roughly 33,000 matched messages/day, not guaranteed unique leads. Real capacity will be lower. Each matching event also performs several reads; the D1 5-million-read limit and Telegram rate limits can become bottlenecks before the theoretical write ceiling.

A monitor interval of 30 seconds corresponds to 2,880 scheduled cycles/day for one continuously running monitoring session. A cycle's workload grows with the number of enabled sources and backlog volume. The application displays cycles/messages, not actual D1 row billing counters.

## D1 migration

Existing 0.1.4 databases apply only `0004_dashboard_templates_phrases.sql` once. New databases run 0001–0004 sequentially. This migration adds phrase settings, templates, monitoring-run history, plan goal/contact fields, lead message date and template/source attribution.

## Bindings and secrets

- D1 binding: `DB`
- Durable Object binding: `TG`
- Required secrets: `ADMIN_TOKEN` (20+ chars), `APP_SECRET` (24+ chars)
- Optional Telegram application keys: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`

## Usage tracking

The Overview dashboard shows measured monitoring cycles, sources and messages plus lead conversion. It does not attempt to reconstruct billing rows or CPU. Use D1 → Metrics → Row Metrics and Workers Analytics for actual resource usage.
