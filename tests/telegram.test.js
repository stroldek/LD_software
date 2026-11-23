import test from 'node:test';
import assert from 'node:assert/strict';
import { getWebDcEndpoint, WEB_DC_HOSTS } from '../src/tg/gramjs.js';

test('WSS transport maps every Telegram DC to its web hostname', () => {
  assert.deepEqual(WEB_DC_HOSTS, { 1: 'pluto', 2: 'venus', 3: 'aurora', 4: 'vesta', 5: 'flora' });
  assert.deepEqual(getWebDcEndpoint(1), { id: 1, ipAddress: 'pluto.web.telegram.org', port: 443 });
  assert.deepEqual(getWebDcEndpoint(2), { id: 2, ipAddress: 'venus.web.telegram.org', port: 443 });
  assert.deepEqual(getWebDcEndpoint(3), { id: 3, ipAddress: 'aurora.web.telegram.org', port: 443 });
  assert.deepEqual(getWebDcEndpoint(4), { id: 4, ipAddress: 'vesta.web.telegram.org', port: 443 });
  assert.deepEqual(getWebDcEndpoint(5), { id: 5, ipAddress: 'flora.web.telegram.org', port: 443 });
});

test('WSS media endpoints use Telegram download DC hostname suffix', () => {
  assert.deepEqual(getWebDcEndpoint(4, true), { id: 4, ipAddress: 'vesta-1.web.telegram.org', port: 443 });
  assert.deepEqual(getWebDcEndpoint(2, true), { id: 2, ipAddress: 'venus-1.web.telegram.org', port: 443 });
});

test('unsupported Telegram data centers fail explicitly', () => {
  assert.throws(() => getWebDcEndpoint(0), /Unsupported Telegram data center/);
  assert.throws(() => getWebDcEndpoint(6), /Unsupported Telegram data center/);
  assert.throws(() => getWebDcEndpoint('abc'), /Unsupported Telegram data center/);
});
