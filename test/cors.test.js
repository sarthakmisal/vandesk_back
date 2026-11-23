'use strict';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { boot } = require('./helpers');

let t;
before(async () => { t = await boot(new Date('2026-11-02T03:30:00Z')); });
after(() => t.close());

describe('CORS (mobile app)', () => {
  it('answers the preflight for the Ionic app origin', async () => {
    const r = await fetch(`${t.base}/api/auth/otp/request`, {
      method: 'OPTIONS',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
  });
  it('adds the header to normal responses for an allowed origin only', async () => {
    const ok = await fetch(`${t.base}/api/health`, { headers: { origin: 'capacitor://localhost' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    const other = await fetch(`${t.base}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});
