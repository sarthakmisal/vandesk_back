'use strict';
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createDb } = require('../src/db');
const { createMailer } = require('../src/mail');
const { seedDemo } = require('../src/seed');

/** Fresh in-memory Postgres (PGlite) with the real schema script and the demo data. */
async function boot(clock) {
  const state = { clock };
  // TEST_DATABASE_URL=postgres://... runs the same tests on a real PostgreSQL server (the schema is rebuilt from scratch)
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    await pool.query('drop schema public cascade; create schema public;');
    await pool.end();
  }
  const cfg = loadConfig({}, { databaseUrl: url, memoryDb: true, autoMigrate: true, staticDir: 'does-not-exist', cronSecret: 'cron-secret', now: () => state.clock, devOtp: true });
  const db = await createDb(cfg);
  await seedDemo(db, state.clock);
  const mail = createMailer({ smtp: undefined, mailFrom: 'x', production: true });
  const server = createApp(cfg, db, mail).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const call = async (token, method, path, body) => {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const cron = (name) => fetch(`${base}/api/internal/jobs/${name}`, { headers: { authorization: 'Bearer cron-secret' } }).then((r) => r.json());
  const signIn = async (email) => {
    const req = await call(null, 'POST', '/auth/otp/request', { email });
    const v = await call(null, 'POST', '/auth/otp/verify', { email, code: req.body.devCode });
    if (v.status !== 200) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(v.body)}`);
    return v.body.token;
  };
  return { state, db, mail, base, call, cron, signIn, close: async () => { server.close(); await db.close(); } };
}
module.exports = { boot };
