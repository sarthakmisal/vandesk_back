'use strict';
// npm run db:seed  ->  loads the demo people and data into an EMPTY database.
require('../src/env');
const { loadConfig } = require('../src/config');
const { createDb } = require('../src/db');
const { seedDemo } = require('../src/seed');

(async () => {
  const cfg = loadConfig(process.env, { autoMigrate: true });
  const db = await createDb(cfg);
  console.log((await seedDemo(db, cfg.now())) ? 'Demo data loaded.' : 'The database already has users, nothing changed.');
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
