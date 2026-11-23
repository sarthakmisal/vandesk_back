'use strict';
/**
 * @typedef {ReturnType<typeof loadConfig>} Config
 */
function loadConfig(env = process.env, over = {}) {
  const production = env.NODE_ENV === 'production' || !!env.VERCEL;
  const secret = env.AUTH_SECRET || '';
  if (production && secret.length < 16) throw new Error('AUTH_SECRET (16+ chars) is required in production');
  if (production && !env.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  if (env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must start with postgresql:// (copy the connection string from the Neon dashboard into .env)');
  }
  const smtpHost = env.SMTP_HOST;
  return {
    port: Number(env.PORT || 3000),
    production,
    secret: secret || 'dev-secret-change-me',
    cronSecret: env.CRON_SECRET || '',
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: env.DATA_DIR || './data/pg',
    memoryDb: false,
    staticDir: env.STATIC_DIR || 'public',
    // Built-in local database (no DATABASE_URL): tables and demo data are created automatically.
    // A real PostgreSQL (Neon, ...): only when AUTO_MIGRATE=1 / SEED_DEMO=1, otherwise you run db/vandesk_schema.sql and db/vandesk_seed.sql yourself.
    seed: env.SEED_DEMO ? env.SEED_DEMO === '1' : !production && !env.DATABASE_URL,
    autoMigrate: env.AUTO_MIGRATE ? env.AUTO_MIGRATE === '1' : !production && !env.DATABASE_URL,
    // Without SMTP (development) the OTP is also returned in the response so the demo works without an inbox. Never in production.
    devOtp: !production && !smtpHost,
    // Browsers / the Ionic (Capacitor) app call the API from another origin. Sign-in is a bearer token (no cookies), so an allow-list is enough.
    corsOrigins: [
      'https://localhost', 'http://localhost', 'capacitor://localhost', 'ionic://localhost',
      'http://localhost:4200', 'http://localhost:8100',
      ...(env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
    ],
    mailFrom: env.MAIL_FROM || 'VanDesk <no-reply@vandesk.test>',
    smtp: smtpHost
      ? { host: smtpHost, port: Number(env.SMTP_PORT || 587), user: env.SMTP_USER, pass: env.SMTP_PASS }
      : undefined,
    now: () => new Date(),
    ...over,
  };
}
module.exports = { loadConfig };
