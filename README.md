# VanDesk backend

Express 5 + PostgreSQL. Serves the API under `/api` and the Ionic build from `public/`.

```
db/vandesk_schema.sql   the whole schema, one script (BEGIN ... COMMIT), same conventions as the Resello script
src/                    config, db, auth, and one file per area: students, fees, trips, notify, admin
scripts/                db:migrate, db:seed
test/                   npm test (PGlite)  |  TEST_DATABASE_URL=postgres://... npm test (real PostgreSQL)
```

## Run locally (no setup)
```
npm install
npm run dev          # http://localhost:3000, built-in Postgres in ./data, demo users loaded
```
Sign in with `ramesh@vandesk.test` (driver), `mrpatil@mail.test` (parent) or `admin@vandesk.test`; the 6-digit code is shown on the sign-in screen in development.

## Neon / any PostgreSQL (do this once)
1. Open `.env` and paste your connection string into `DATABASE_URL=` (Neon dashboard > Connect). Pooled or direct endpoint both work.
2. In the Neon SQL Editor (or `psql "$DATABASE_URL" -f ...`) run **`db/vandesk_schema.sql`**, then **`db/vandesk_seed.sql`**.
   - Seed: edit the 3 variables at the top first: `admin_email` (your real email), `admin_name`, `load_demo` (TRUE = 2 buses, 7 students, dues and payments to play with; FALSE = only the admin).
   - Both are safe to re-run: nothing is duplicated.
3. `npm install && npm run dev`. The log must say `Database: PostgreSQL <your-neon-host>/<db>` and `Database ready: N users`.
4. Sign in with the admin email. In development (`NODE_ENV=development`, no SMTP) the 6-digit code is shown on the sign-in screen.
5. Frontend: in the `vandesk` app project run `npm run build:back` (copies the app into this folder's `public/`), then open http://localhost:3000. For the Ionic mobile app see the app README (CORS for it is already allowed here; extra origins via `CORS_ORIGINS`).

Notes: with `DATABASE_URL` set, the app does not create tables or demo data itself (set `AUTO_MIGRATE=1` / `SEED_DEMO=1` if you want that). Without it, the built-in local database is used and everything is automatic. TLS is verified against Neon's certificate; only for a self-signed server set `DB_SSL_INSECURE=1`. `npm run db:seed` is the JS alternative to the SQL seed.

## Production (Vercel + Neon)
1. Run the two SQL files on the production database (as above).
2. In Vercel set `DATABASE_URL`, `AUTH_SECRET` (16+ chars), `CRON_SECRET`, `SMTP_*`, `MAIL_FROM` (production emails the sign-in code; there is no on-screen code).
3. Frontend: `npm run build:back` in the `vandesk` app project, then deploy. `vercel.json` schedules the three daily jobs (dues, reminders, retention).

## Admin (VanDesk team)
The admin sets everything up; drivers run the day. All under `/api/admin/*` (role `admin` only, audited):
- **Buses:** `POST /admin/vehicles` (name, reg no, seats, first monthly fee, driver name + email, optional stops), `PUT /admin/vehicles/:id` (edit; seats cannot drop below students on board), `PUT /admin/vehicles/:id/in-service` (retire needs an empty bus; restore).
- **Driver:** `PUT /admin/vehicles/:id/driver` replaces the driver by email (the old one is suspended; an existing driver without a bus is re-used). Drivers sign in with an email code, no password. `PUT /admin/drivers/:id` suspends or activates.
- **Stops:** `POST /admin/vehicles/:id/stops`, `PUT /admin/stops/:id`, `POST /admin/stops/:id/move {dir}`, `DELETE /admin/stops/:id` (refused while students use it). The route order drives the driver's next-student order.
- **Fees:** `POST /admin/vehicles/:id/fee-plans {amount, from}` per bus. A bus must have a fee plan before students can join it, otherwise no dues would be raised.
- **Students:** `POST /students` works for any bus in service; `PUT /admin/students/:id/placement {veh, stop}` moves a student (seat limit enforced; fees follow the student, existing dues keep their amount).

## Data rules worth knowing
- Money is integer paise. Payments are append-only: a mistake is a reversal row (a payment can be reversed once, enforced by a UNIQUE constraint).
- `enum_master` holds every status/kind/mode; `src/enums.js` mirrors it and `npm test` fails if they drift.
- A student pays the full month they join in. Overpayment becomes advance credit and pays the next due automatically.
- Parents never see an exact position: coordinates are rounded to ~100 m, and raw coordinates are cleared after 90 days.
