'use strict';
// npm run db:migrate  ->  runs db/vandesk_schema.sql on an EMPTY database (local dev database or DATABASE_URL). Safe to re-run: it does nothing when the tables exist.
require('../src/env');
const { loadConfig } = require('../src/config');
const { createDb, migrate } = require('../src/db');

(async () => {
  const cfg = loadConfig(process.env, { autoMigrate: false });
  const db = await createDb(cfg);
  console.log((await migrate(db)) ? 'Schema created.' : 'Schema already exists, nothing changed.');
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
