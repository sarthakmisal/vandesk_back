'use strict';
require('./src/env'); // .env first, before anything reads process.env
const express = require('express');
const { loadConfig } = require('./src/config');
const { createDb, describeDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createMailer } = require('./src/mail');
const { seedDemo } = require('./src/seed');

const cfg = loadConfig();

/** Connect once per process (serverless keeps the module warm between requests). */
const ready = (async () => {
  console.log(`Database: ${describeDb(cfg)}`);
  const db = await createDb(cfg);
  if ((await db.query("select to_regclass('public.users') as t")).rows[0].t === null) {
    throw new Error('The database has no tables yet. Run db/vandesk_schema.sql on it first (then db/vandesk_seed.sql for the first users).');
  }
  if (cfg.seed && (await seedDemo(db, cfg.now()))) console.log('Seeded demo data (set SEED_DEMO=0 to disable)');
  const users = (await db.query('select count(*)::int as n from users')).rows[0].n;
  console.log(`Database ready: ${users} users`);
  if (users === 0) console.warn('WARNING: the database is empty, so nobody can sign in. Run `npm run db:seed` or add real users.');
  if (cfg.production && !cfg.smtp) console.warn('WARNING: no SMTP settings, so sign-in codes cannot be delivered. Set SMTP_HOST / SMTP_USER / SMTP_PASS.');
  return createApp(cfg, db, createMailer(cfg));
})();
ready.catch((e) => console.error('Startup failed:', e));

const app = express();
app.use(async (req, res, next) => {
  try {
    (await ready)(req, res, next);
  } catch {
    res.status(503).json({ error: 'Service starting, try again' });
  }
});

if (!process.env.VERCEL) app.listen(cfg.port, () => console.log(`VanDesk API on http://localhost:${cfg.port}`));

module.exports = app;
