import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const fakeDB = {
  prepare(sql) {
    return {
      first: async () => {
        if (sql.includes('COUNT(*)')) return { total: 4 };
        return null;
      },
    };
  },
};

function env() {
  return {
    DB: fakeDB,
    ADMIN_TOKEN: 'test-admin-token-0123456789',
    APP_SECRET: 'test-app-secret-0123456789abcdef',
    TG: {
      idFromName: () => 'main',
      get: () => ({ invoke: async () => ({ ok: true, data: null }) }),
    },
  };
}

function adminHeaders(extra = {}) {
  return { authorization: 'Bearer test-admin-token-0123456789', ...extra };
}

test('health endpoint reports Worker and D1 without Bot API configuration', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/api/health'), { DB: fakeDB });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.checks.worker, 'ok');
  assert.equal(body.checks.database, 'connected');
  assert.equal('telegram' in body.checks, false);
  assert.equal(body.leads_count, 4);
});

test('removed Bot API webhook and setup routes do not exist', async () => {
  const webhook = await worker.fetch(new Request('https://example.workers.dev/api/telegram/webhook', {
    method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ update_id: 1 }),
  }), env());
  const setup = await worker.fetch(new Request('https://example.workers.dev/api/setup/telegram-webhook', {
    method: 'POST', headers: adminHeaders({ 'x-setup-token': 'wrong-token' }),
  }), env());
  assert.equal(webhook.status, 404);
  assert.equal(setup.status, 404);
});
