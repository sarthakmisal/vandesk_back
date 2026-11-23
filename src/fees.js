'use strict';
const { E, name } = require('./enums');
const { HttpError } = require('./errors');
const { need } = require('./auth');
const { scope, visibleStudent, audit } = require('./access');
const { monthStart } = require('./time');

const ACTIVE = E.student_status.active;
const KIND = E.payment_kind;

/**
 * One due per student per month (unique), amount from the vehicle's fee plan in force.
 * A mid-month joiner pays the full month. Idempotent: safe to run every day.
 */
async function generateDues(q, period) {
  const r = await q.query(
    `insert into fee_dues (student_id, due_month, amount)
     select s.id, $1::date, p.amount from students s
     join lateral (select amount from fee_plans where vehicle_id = s.vehicle_id and effective_from <= $1::date order by effective_from desc limit 1) p on true
     where s.status = ${ACTIVE} and s.joined_on <= $1::date
     on conflict (student_id, due_month) do nothing returning student_id`,
    [monthStart(period)],
  );
  for (const row of r.rows) await applyCredit(q, row.student_id);
  return r.rows.length;
}

/** Oldest due first. */
async function allocate(q, paymentId, sid, amount) {
  const dues = await q.query(
    'select id, outstanding from fee_due_balances where student_id = $1 and outstanding > 0 order by due_month',
    [sid],
  );
  let left = amount;
  for (const d of dues.rows) {
    if (left <= 0) break;
    const take = Math.min(left, d.outstanding);
    await q.query('insert into payment_allocations(payment_id, due_id, amount) values ($1,$2,$3)', [paymentId, d.id, take]);
    left -= take;
  }
}

/** Overpayment is advance credit, applied to new dues when they are generated. */
async function applyCredit(q, sid) {
  const { credit } = (await q.query('select credit from student_credits where student_id = $1', [sid])).rows[0];
  if (credit > 0) {
    const p = await q.query(
      `select id from payments where student_id = $1 and kind = ${KIND.payment} order by created_at desc, id desc limit 1`,
      [sid],
    );
    if (p.rows[0]) await allocate(q, p.rows[0].id, sid, credit);
  }
}

async function applyPayment(q, sid, amount, mode, paidOn, by, uuid) {
  if (uuid) {
    const ex = await q.query('select id from payments where client_uuid = $1', [uuid]);
    if (ex.rows[0]) return { id: ex.rows[0].id, duplicate: true };
  }
  const id = (
    await q.query(
      `insert into payments(student_id, kind, amount, mode, paid_on, recorded_by, client_uuid) values ($1,${KIND.payment},$2,$3,$4,$5,$6) returning id`,
      [sid, amount, E.payment_mode[mode], paidOn, by, uuid],
    )
  ).rows[0].id;
  await allocate(q, id, sid, amount);
  return { id, duplicate: false };
}

async function pending(q, u) {
  need(u, 'fees.read');
  const sc = scope(u, 's', 1);
  const r = await q.query(
    `select s.id::text as id, s.name, s.class_name as cls, s.vehicle_id::text as veh, v.name as vehicle,
            to_char(b.due_month, 'YYYY-MM') as period, b.outstanding as out
     from students s
     join vehicles v on v.id = s.vehicle_id
     join fee_due_balances b on b.student_id = s.id
     where s.status = ${ACTIVE} and ${sc.sql} and b.outstanding > 0
     order by b.due_month, s.name`,
    sc.params,
  );
  const by = new Map();
  for (const x of r.rows) {
    const e = by.get(x.id) ?? { id: x.id, name: x.name, cls: x.cls, vehicle: x.vehicle, veh: x.veh, months: 0, balance: 0, steps: [], since: x.period };
    e.months += 1;
    e.balance += x.out;
    e.steps.push(e.balance); // 1 month, 2 months... cumulative: the quick-pay chips
    by.set(x.id, e);
  }
  return [...by.values()].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.name.localeCompare(b.name)));
}

async function collectedToday(q, u, today) {
  need(u, 'fees.read');
  const sc = scope(u, 's', 2);
  const r = await q.query(
    `select coalesce(sum(case when p.kind = ${KIND.payment} then p.amount else -p.amount end), 0)::int as n
     from payments p join students s on s.id = p.student_id where p.paid_on = $1::date and ${sc.sql}`,
    [today, ...sc.params],
  );
  return r.rows[0].n;
}

async function statement(q, u, sid) {
  need(u, 'fees.read');
  const s = await visibleStudent(q, u, sid);
  const rows = (
    await q.query(
      `select to_char(due_month, 'YYYY-MM') as per, amount as amt, (amount - outstanding) as paid
       from fee_due_balances where student_id = $1 order by due_month`,
      [sid],
    )
  ).rows;
  return { name: s.name, balance: rows.reduce((x, r) => x + r.amt - r.paid, 0), rows };
}

async function ledger(q, u) {
  need(u, 'fees.read');
  const sc = scope(u, 's', 1);
  const rows = (
    await q.query(
      `select p.id::text as id, s.name as student, p.kind, p.amount, p.mode, p.paid_on::text as paid_on, coalesce(p.note, '') as note,
              exists (select 1 from payments r where r.reversal_of = p.id) as reversed
       from payments p join students s on s.id = p.student_id where ${sc.sql}
       order by p.created_at desc, p.id desc limit 100`,
      sc.params,
    )
  ).rows;
  return rows.map((r) => ({ ...r, kind: name('payment_kind', r.kind), mode: name('payment_mode', r.mode) }));
}

async function recordPayment(db, u, f, today) {
  need(u, 'fees.record');
  return db.tx(async (q) => {
    await visibleStudent(q, u, f.studentId);
    await q.query('select id from students where id = $1 for update', [f.studentId]); // one payment at a time per student
    const s = await visibleStudent(q, u, f.studentId);
    const r = await applyPayment(q, s.id, f.amount, f.mode, today, u.id, f.clientUuid ?? null);
    const balance = (await statement(q, u, s.id)).balance;
    return { ...r, studentId: s.id, studentName: s.name, balance };
  });
}

/** A reversal row plus negative allocations. The original row is never edited or deleted. */
async function reversePayment(db, u, pid, note, today) {
  need(u, 'fees.record');
  if (!note.trim()) throw new HttpError(400, 'A reason is required');
  if (!/^\d+$/.test(pid)) throw new HttpError(404, 'Payment not found');
  await db.tx(async (q) => {
    const o = (
      await q.query(`select id, student_id, amount, mode from payments where id = $1 and kind = ${KIND.payment}`, [pid])
    ).rows[0];
    if (!o) throw new HttpError(404, 'Payment not found');
    await visibleStudent(q, u, o.student_id);
    if ((await q.query('select 1 from payments where reversal_of = $1', [pid])).rows.length) {
      throw new HttpError(409, 'Already reversed');
    }
    const rid = (
      await q.query(
        `insert into payments(student_id, kind, amount, mode, paid_on, recorded_by, reversal_of, note) values ($1,${KIND.reversal},$2,$3,$4,$5,$6,$7) returning id`,
        [o.student_id, o.amount, o.mode, today, u.id, pid, note.trim()],
      )
    ).rows[0].id;
    await q.query('insert into payment_allocations(payment_id, due_id, amount) select $1, due_id, -amount from payment_allocations where payment_id = $2', [rid, pid]);
    await audit(q, u.id, 'payment.reverse', 'payment', pid, note.trim());
  });
}

async function plans(q, u) {
  need(u, 'fees.read');
  return (
    await q.query(
      `select id::text as id, vehicle_id::text as veh, amount, effective_from::text as effective_from
       from fee_plans where ($1::text = 'admin' or vehicle_id = $2) order by effective_from desc`,
      [u.role, u.vehicle_id],
    )
  ).rows;
}

/**
 * A new plan applies from its start month. Dues that already exist never change.
 * Driver: own vehicle. Admin: any vehicle (`vehicleId`).
 */
async function addPlan(q, u, amount, from, vehicleId) {
  need(u, u.role === 'admin' ? 'fees.plan' : 'fees.record');
  const vid = u.role === 'admin' ? vehicleId : u.vehicle_id;
  if (!vid || !/^\d+$/.test(String(vid))) throw new HttpError(403, 'Not allowed');
  if (!(await q.query('select 1 from vehicles where id = $1', [vid])).rows[0]) throw new HttpError(404, 'Not found');
  const last = (
    await q.query('select effective_from::text as f from fee_plans where vehicle_id = $1 order by effective_from desc limit 1', [vid])
  ).rows[0];
  if (last && from <= last.f) throw new HttpError(409, 'Start date must be after the current plan starts');
  const id = (
    await q.query('insert into fee_plans(vehicle_id, amount, effective_from, created_by) values ($1,$2,$3,$4) returning id', [vid, amount, from, u.id])
  ).rows[0].id;
  await audit(q, u.id, 'plan.add', 'fee_plan', id, `vehicle ${vid}: ${amount} from ${from}`);
  return { id };
}

module.exports = { generateDues, applyPayment, pending, collectedToday, statement, ledger, recordPayment, reversePayment, plans, addPlan };
