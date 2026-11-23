from pathlib import Path
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / 'migrations' / '0001_stage1_prototype.sql',
    ROOT / 'migrations' / '0002_live_telegram_test.sql',
    ROOT / 'migrations' / '0003_account_credentials_no_bot.sql',
]

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / 'stage1.sqlite'
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA foreign_keys = ON')

    # Apply the previous schema and simulate encrypted keys already stored by v0.1.3.
    conn.executescript(MIGRATIONS[0].read_text(encoding='utf-8'))
    conn.executescript(MIGRATIONS[1].read_text(encoding='utf-8'))
    conn.execute(
        "INSERT INTO tg_account (id, api_id_enc, api_hash_enc, status) VALUES (1, 'enc-api-id', 'enc-api-hash', 'logged_out')"
    )
    conn.execute("INSERT INTO leads (id, telegram_id, source) VALUES ('lead-1', '10001', 'telegram_bot')")
    conn.commit()

    # Migration 0003 must move app credentials, retain the account row and leads,
    # and retire all Bot API persistence structures.
    conn.executescript(MIGRATIONS[2].read_text(encoding='utf-8'))

    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    expected = {'schema_migrations', 'leads', 'tg_account', 'tg_app_credentials', 'monitor_sources', 'monitor_settings'}
    assert expected.issubset(tables), f'Missing tables: {expected - tables}'
    assert 'consent_events' not in tables
    assert 'telegram_updates' not in tables

    versions = {row[0] for row in conn.execute('SELECT version FROM schema_migrations')}
    assert versions == {'0001_stage1_prototype', '0002_live_telegram_test', '0003_account_credentials_no_bot'}

    app_creds = conn.execute('SELECT api_id_enc, api_hash_enc FROM tg_app_credentials WHERE id = 1').fetchone()
    assert app_creds == ('enc-api-id', 'enc-api-hash'), app_creds
    account = conn.execute('SELECT api_id_enc, api_hash_enc, status FROM tg_account WHERE id = 1').fetchone()
    assert account == (None, None, 'logged_out'), account

    lead = conn.execute('SELECT telegram_id, source FROM leads WHERE id = ? ', ('lead-1',)).fetchone()
    assert lead == ('10001', 'telegram_account_monitor'), lead

    # Current lead uniqueness remains enforced after the migration.
    try:
        conn.execute("INSERT INTO leads (id, telegram_id) VALUES ('lead-2','10001')")
        raise AssertionError('UNIQUE constraint did not protect telegram_id')
    except sqlite3.IntegrityError:
        pass

    print('PASS: migrations 0001, 0002 and 0003 apply in order')
    print('PASS: existing encrypted API credentials are preserved in the app-credentials table')
    print('PASS: user-account session/status row is retained and API key columns are cleared')
    print('PASS: Bot API consent and update tables are removed')
    print('PASS: existing leads are preserved and re-labelled to personal-account source')
    print('PASS: telegram_id remains unique')
    conn.close()
