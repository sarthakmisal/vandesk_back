'use strict';
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const compression = require('compression');
const express = require('express');
const { z, ZodError } = require('zod');

const auth = require('./auth');
const { E } = require('./enums');
const { HttpError } = require('./errors');
const { defaultDirection, ist } = require('./time');
const { tpl } = require('./mail');
const students = require('./students');
const fees = require('./fees');
const trips = require('./trips');
const admin = require('./admin');
const notify = require('./notify');

const id = z.string().regex(/^\d+$/, 'Invalid id');
const dir = z.enum(['pickup', 'drop']);
const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'));
const money = z.number().int().positive().max(10_000_000);

/**
 * @param {import('./config').Config} cfg
 * @param {import('./db').Db} db
 * @param {ReturnType<typeof import('./mail').createMailer>} mail
 */
function createApp(cfg, db, mail) {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  // CORS for the mobile app and dev servers on another origin (allow-list in config.corsOrigins).
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));

  /** Wraps a route: signed-in user in, JSON out. Express 5 forwards rejected promises to the error handler. */
  const handler = (fn) => async (req, res) => res.json((await fn(req, res.locals.user)) ?? { ok: true });
  const direction = (req) => dir.safeParse(req.query.direction ?? req.body?.direction).data ?? defaultDirection(cfg.now());
  const pid = (req) => id.parse(req.params.id);
  const today = () => ist(cfg.now()).date;

  const account = (u) => ({
    id: String(u.id),
    name: u.name,
    email: u.email,
    role: u.role,
    veh: u.vehicle_id ? String(u.vehicle_id) : undefined,
    gid: u.role === 'parent' ? String(u.id) : undefined,
  });

  /* ---------------------------------------------------------------- auth */
  api.get('/health', (_req, res) => void res.json({ ok: true }));

  api.post('/auth/otp/request', async (req, res) => {
    const { email: to } = z.object({ email }).parse(req.body);
    const now = cfg.now();
    const u = (await db.query(auth.USER_BY_EMAIL, [to])).rows[0];
    let devCode;
    if (u?.active) {
      const n = (
        await db.query('select count(*)::int as n from auth_otp where email = $1 and created_at > $2', [to, new Date(now.getTime() - 3600_000).toISOString()])
      ).rows[0].n;
      if (n >= 5) throw new HttpError(429, 'Too many codes requested. Try again in an hour.');
      const code = auth.newCode();
      await db.query('insert into auth_otp(email, otp_hash, expires_at, created_at) values ($1,$2,$3,$4)', [
        to,
        auth.hashCode(cfg.secret, to, code),
        new Date(now.getTime() + 5 * 60_000).toISOString(),
        now.toISOString(),
      ]);
      const m = tpl.otp(code);
      await mail.send(to, m.subject, m.text);
      devCode = cfg.devOtp ? code : undefined;
    }
    res.json({ ok: true, devCode }); // same answer whether or not the email exists: no account enumeration
  });

  api.post('/auth/otp/verify', async (req, res) => {
    const body = z.object({ email, code: z.string().trim().length(6) }).parse(req.body);
    const now = cfg.now();
    const c = (
      await db.query('select id, otp_hash, attempts from auth_otp where email = $1 and not is_used and expires_at > $2 order by id desc limit 1', [body.email, now.toISOString()])
    ).rows[0];
    if (!c || c.attempts >= 5) {
      throw new HttpError(c ? 429 : 401, c ? 'Too many wrong codes. Request a new one.' : 'Code expired. Request a new one.');
    }
    if (c.otp_hash !== auth.hashCode(cfg.secret, body.email, body.code)) {
      await db.query('update auth_otp set attempts = attempts + 1 where id = $1', [c.id]);
      throw new HttpError(401, 'Wrong code');
    }
    await db.query('update auth_otp set is_used = true where id = $1', [c.id]);
    const u = (await db.query(auth.USER_BY_EMAIL, [body.email])).rows[0];
    if (!u?.active) throw new HttpError(403, 'Account suspended. Contact VanDesk.');
    await db.query('update users set is_verified = true, last_login_at = now() where id = $1', [u.id]);
    res.json({ token: auth.signToken(cfg.secret, u, now), account: account(u) });
  });

  /* ------------------------------------------- cron jobs (secret, not a user) */
  api.get('/internal/jobs/:name', async (req, res) => {
    const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!cfg.cronSecret || given !== cfg.cronSecret) throw new HttpError(401, 'Unauthorized');
    const now = cfg.now();
    const jobs = {
      'generate-dues': async () => ({ created: await fees.generateDues(db, ist(now).period) }),
      'send-reminders': () => notify.sendReminders(db, mail, now, { manual: false }),
      retention: () => trips.retention(db, now),
    };
    const job = jobs[req.params.name];
    if (!job) throw new HttpError(404, 'Unknown job');
    res.json(await job());
  });

  /* ------------------------------------- everything below needs a signed-in user */
  api.use(async (req, res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const uid = token ? auth.verifyToken(cfg.secret, token, cfg.now()) : null;
    const u = uid ? (await db.query(auth.USER_BY_ID, [uid])).rows[0] : undefined;
    if (!u || !u.active) throw new HttpError(401, u ? 'Account suspended. Contact VanDesk.' : 'Please sign in');
    res.locals.user = u;
    next();
  });

  api.get('/me', handler(async (_r, u) => account(u)));

  /* ------------------------------------------------------------- students */
  api.get('/vehicles', handler((_r, u) => students.listVehicles(db, u)));
  api.get('/vehicles/:id/stops', handler((req, u) => students.listStops(db, u, req.params.id)));
  api.get('/students', handler((_r, u) => students.listStudents(db, u)));
  api.post(
    '/students',
    handler(async (req, u) => {
      const f = z
        .object({
          name: z.string().trim().min(1, 'Student name is required').max(80),
          cls: z.string().trim().max(20).default(''),
          veh: id,
          stop: z.union([id, z.literal('')]).default(''),
          gname: z.string().trim().min(1, 'Guardian name is required').max(80),
          email,
          phone: z.string().trim().max(15).default(''),
        })
        .parse(req.body);
      const r = await students.addStudent(db, u, f, ist(cfg.now()).period, fees.generateDues);
      await notify.mailInvite(db, mail, r.id);
      return { id: r.id };
    }),
  );
  api.put(
    '/admin/students/:id/placement',
    handler((req, u) => {
      const f = z.object({ veh: id, stop: z.union([id, z.literal('')]).default('') }).parse(req.body);
      return students.moveStudent(db, u, pid(req), f, ist(cfg.now()).period);
    }),
  );

  /* ----------------------------------------------------------------- fees */
  api.get('/fees/pending', handler((_r, u) => fees.pending(db, u)));
  api.get('/fees/collected-today', handler(async (_r, u) => ({ amount: await fees.collectedToday(db, u, today()) })));
  api.get('/students/:id/statement', handler((req, u) => fees.statement(db, u, req.params.id)));
  api.get('/payments', handler((_r, u) => fees.ledger(db, u)));
  api.post(
    '/payments',
    handler(async (req, u) => {
      const f = z
        .object({
          studentId: id,
          amount: money,
          mode: z.enum(Object.keys(E.payment_mode)),
          clientUuid: z.uuid().optional(),
        })
        .parse(req.body);
      const r = await fees.recordPayment(db, u, f, today());
      if (!r.duplicate) await notify.mailReceipt(db, mail, r.id, r.studentId, f.amount, r.balance, today());
      return { id: r.id };
    }),
  );
  api.post(
    '/payments/:id/reverse',
    handler(async (req, u) => {
      await fees.reversePayment(db, u, req.params.id, z.object({ note: z.string().default('') }).parse(req.body ?? {}).note, today());
    }),
  );
  api.get('/fee-plans', handler((_r, u) => fees.plans(db, u)));
  api.post(
    '/fee-plans',
    handler(async (req, u) => {
      const f = z.object({ amount: money, from: z.iso.date() }).parse(req.body);
      return fees.addPlan(db, u, f.amount, f.from);
    }),
  );
  api.post(
    '/reminders/send',
    handler(async (_r, u) => {
      auth.need(u, 'fees.record');
      return notify.sendReminders(db, mail, cfg.now(), { vehicle: u.vehicle_id, manual: true });
    }),
  );

  /* ---------------------------------------------------------------- trips */
  api.get('/trip', handler((req, u) => trips.tripView(db, u, direction(req), cfg.now())));
  api.post('/trip/start', handler((req, u) => trips.tripStart(db, u, direction(req), cfg.now())));
  api.post('/trip/end', handler((req, u) => trips.tripEnd(db, u, direction(req), cfg.now())));
  api.post(
    '/trip/tap',
    handler(async (req, u) => {
      const f = z
        .object({
          studentId: id,
          direction: dir,
          kind: z.enum(['boarded', 'skipped']).default('boarded'),
          lat: z.number().min(-90).max(90).optional(),
          lng: z.number().min(-180).max(180).optional(),
          accuracy: z.number().min(0).optional(),
        })
        .parse(req.body);
      return trips.tripTap(db, u, f, cfg.now());
    }),
  );

  api.get('/children', handler((_r, u) => trips.children(db, u)));
  api.get('/children/:id/trip', handler((req, u) => trips.parentTrip(db, u, pid(req), direction(req), cfg.now())));
  api.put(
    '/children/:id/attendance',
    handler(async (req, u) => {
      const f = z.object({ going: z.boolean(), direction: dir }).parse(req.body);
      return trips.setGoing(db, u, pid(req), f.going, f.direction, cfg.now());
    }),
  );

  /* ---------------------------------------------------------------- admin */
  api.get('/admin/overview', handler((_r, u) => admin.adminOverview(db, u, cfg.now())));
  api.put(
    '/admin/drivers/:id',
    handler(async (req, u) => {
      await admin.setDriverActive(db, u, req.params.id, z.object({ active: z.boolean() }).parse(req.body).active);
    }),
  );

  const text = (max) => z.string().trim().min(1, 'Required').max(max);
  const typical = z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'), z.literal('')]);
  const vehicleFields = { name: text(30), regNo: z.string().trim().min(4, 'Enter the registration number').max(20), capacity: z.number().int().min(1).max(80) };
  const driverFields = { name: text(80), email };

  api.post(
    '/admin/vehicles',
    handler((req, u) => {
      const f = z
        .object({ ...vehicleFields, fee: money, driverName: driverFields.name, driverEmail: email, stops: z.array(text(80)).max(40).default([]) })
        .parse(req.body);
      return admin.addVehicle(db, u, f, ist(cfg.now()).period);
    }),
  );
  api.put(
    '/admin/vehicles/:id',
    handler((req, u) => admin.updateVehicle(db, u, pid(req), z.object(vehicleFields).partial().parse(req.body))),
  );
  api.put(
    '/admin/vehicles/:id/in-service',
    handler((req, u) => admin.setVehicleInService(db, u, pid(req), z.object({ inService: z.boolean() }).parse(req.body).inService)),
  );
  api.put(
    '/admin/vehicles/:id/driver',
    handler((req, u) => admin.changeDriver(db, u, pid(req), z.object(driverFields).parse(req.body))),
  );
  api.post(
    '/admin/vehicles/:id/fee-plans',
    handler((req, u) => {
      auth.need(u, 'fees.plan');
      const f = z.object({ amount: money, from: z.iso.date() }).parse(req.body);
      return fees.addPlan(db, u, f.amount, f.from, pid(req));
    }),
  );
  api.post(
    '/admin/vehicles/:id/stops',
    handler((req, u) => admin.addStop(db, u, pid(req), z.object({ name: text(80), typical: typical.default('') }).parse(req.body))),
  );
  api.put(
    '/admin/stops/:id',
    handler((req, u) => admin.updateStop(db, u, pid(req), z.object({ name: text(80), typical }).partial().parse(req.body))),
  );
  api.post(
    '/admin/stops/:id/move',
    handler((req, u) => admin.moveStop(db, u, pid(req), z.object({ dir: z.enum(['up', 'down']) }).parse(req.body).dir)),
  );
  api.delete('/admin/stops/:id', handler((req, u) => admin.deleteStop(db, u, pid(req))));

  api.use(() => {
    throw new HttpError(404, 'Not found');
  });
  app.use('/api', api);

  /* --------------------------------------------- static app (the Ionic build in public/) */
  const root = resolve(cfg.staticDir);
  if (existsSync(resolve(root, 'index.html'))) {
    app.use(
      express.static(root, {
        index: false,
        setHeaders: (res, file) => {
          const hashed = /[-.][A-Za-z0-9_]{8,}\.(js|css|woff2?)$/.test(file);
          res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
        },
      }),
    );
    // App routes (no file extension) get index.html; a missing file is a real 404, never index.html.
    app.use((req, res, next) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && !/\.[a-z0-9]+$/i.test(req.path)) {
        res.setHeader('Cache-Control', 'no-cache');
        return void res.sendFile(resolve(root, 'index.html'));
      }
      next();
    });
  }

  app.use((e, _req, res, _next) => {
    if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
    if (e instanceof ZodError) return void res.status(400).json({ error: e.issues[0]?.message ?? 'Invalid request' });
    if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON' });
    if (e?.code === '23505') return void res.status(409).json({ error: 'Already exists' }); // unique violation that raced past the checks
    console.error(e);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}

module.exports = { createApp };
