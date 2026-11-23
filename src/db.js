'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const SCHEMA_FILE = join(__dirname, '..', 'db', 'vandesk_schema.sql');

/**
 * @typedef {{ query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }} Q
 * @typedef {Q & { tx<T>(fn: (q: Q) => Promise<T>): Promise<T>, close(): Promise<void> }} Db
 */

/** Runs db/vandesk_schema.sql once. Returns false when the tables already exist. */
async function migrate(/** @type {Q & { exec?: Function }} */ db) {
  const r = await db.query("select to_regclass('public.users') as t");
  if (r.rows[0].t) return false;
  const sql = readFileSync(SCHEMA_FILE, 'utf8');
  if (db.exec) await db.exec(sql);
  else await db.query(sql); // pg runs a multi-statement script when there are no parameters
  return true;
}

/**
 * DATABASE_URL set -> PostgreSQL through `pg` (production).
 * otherwise        -> PGlite (real Postgres compiled to WASM): zero setup for development and tests, persisted in DATA_DIR.
 * @returns {Promise<Db>}
 */
async function createDb(cfg) {
  if (cfg.databaseUrl) {
    const { Pool } = require('pg');
    const local = /sslmode=disable|@(localhost|127\.0\.0\.1)[:/]/.test(cfg.databaseUrl);
    // Hosted PostgreSQL (Neon etc.) is reached over TLS with the certificate verified. DB_SSL_INSECURE=1 skips verification (self-signed servers only).
    const ssl = local ? undefined : { rejectUnauthorized: process.env.DB_SSL_INSECURE !== '1' };
    // The TLS options above are the single source of truth: drop sslmode / channel_binding from the URL so pg does not second-guess them.
    const url = new URL(cfg.databaseUrl);
    for (const k of ['sslmode', 'channel_binding', 'uselibpqcompat']) url.searchParams.delete(k);
    const pool = new Pool({ connectionString: url.toString(), max: cfg.production ? 3 : 10, ssl, connectionTimeoutMillis: 30000 });
    // Serverless Postgres closes idle connections; without this handler that would crash the process.
    pool.on('error', (e) => console.warn('Idle database connection closed:', e.message));
    if (cfg.autoMigrate) await migrate(pool);
    return {
      query: (sql, params) => pool.query(sql, params),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const out = await fn({ query: (sql, params) => c.query(sql, params) });
          await c.query('commit');
          return out;
        } catch (e) {
          await c.query('rollback');
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite, types } = await import('@electric-sql/pglite');
  // bigint ids as strings, exactly like `pg` returns them, so development, tests and production behave the same
  if (!cfg.memoryDb) require('node:fs').mkdirSync(cfg.dataDir, { recursive: true });
  const lite = new PGlite({ ...(cfg.memoryDb ? {} : { dataDir: cfg.dataDir }), parsers: { [types.INT8]: (v) => v } });
  await lite.waitReady;
  if (cfg.autoMigrate) await migrate(lite);
  return {
    query: (sql, params) => lite.query(sql, params),
    tx: (fn) => lite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) })),
    close: () => lite.close(),
  };
}

/** Human-readable target for the start-up log (never prints the password). */
function describeDb(cfg) {
  if (!cfg.databaseUrl) return `built-in local database (${cfg.dataDir})`;
  try {
    const u = new URL(cfg.databaseUrl);
    return `PostgreSQL ${u.hostname}${u.pathname}`;
  } catch {
    return 'PostgreSQL';
  }
}

module.exports = { createDb, migrate, describeDb, SCHEMA_FILE };
