# Acceptance — v1.5.0

## Automated checks
- `npm test`: Node unit/API tests including phrase matching, template storage, run metrics, goal closure notification and password-protected clear.
- `python3 tests/sqlite_schema_test.py`: migrations 0001–0004 and preservation of existing account/lead data.
- `tests/ui_e2e.py`: browser test (requires installed Chromium/Playwright).

## Manual acceptance
1. Apply migration 0004 only after 0001–0003 are already present.
2. Save a filter template with keywords and phrases, switch between matching modes, and apply it again.
3. Confirm matching phrases are captured; verify trigger message date and database-added date differ where appropriate.
4. Attempt database clear without password, with wrong password, and with the correct panel password. Only the last should succeed.
5. Start monitoring and verify elapsed time, cycles, chats and messages reset for this start. Stop and start again to confirm counters reset.
6. Set a lead target and optionally a template/source; verify the goal is marked closed once and one message is sent to the configured contact username.
7. Review «Потенциальные источники»: it filters the connected account's available dialogs and supports bulk add to monitoring; it does not search Telegram globally or join communities.
8. Verify journal is a separate navigation item and sidebar logo has transparent background.
9. Check exact D1/Workers billing metrics in Cloudflare Analytics; app dashboard activity counts are not exact billing counters.
