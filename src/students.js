'use strict';
const { E } = require('./enums');
const { HttpError } = require('./errors');
const { need } = require('./auth');
const { forbidden, scope, audit } = require('./access');
const { monthStart } = require('./time');

const ACTIVE = E.student_status.active;
const LEFT = E.student_status.left;

async function listVehicles(q, u) {
  need(u, 'students.read');
  const r = await q.query(
    `select v.id::text as id, v.name || ' · ' || v.reg_no as label, v.name as short, v.capacity as cap,
            (select count(*)::int from students s where s.vehicle_id = v.id and s.status <> ${LEFT}) as used
     from vehicles v where v.status = ${E.vehicle_status.active} and ($1::text = 'admin' or v.id = $2) order by v.id`,
    [u.role, u.vehicle_id],
  );
  return r.rows;
}

async function listStops(q, u, vehicleId) {
  need(u, 'students.read');
  if (!/^\d+$/.test(vehicleId) || (u.role !== 'admin' && String(u.vehicle_id) !== vehicleId)) throw forbidden();
  const r = await q.query(
    `select id::text as id, vehicle_id::text as veh, name, seq, coalesce(to_char(typical_time, 'HH24:MI'), '') as typical
     from stops where vehicle_id = $1 order by seq`,
    [vehicleId],
  );
  return r.rows;
}

async function listStudents(q, u) {
  need(u, 'students.read');
  const sc = scope(u, 's', 1);
  const r = await q.query(
    `select s.id::text as id, s.name, s.class_name as cls, v.name as vehicle, s.vehicle_id::text as veh, coalesce(s.stop_id::text, '') as "stopId",
            coalesce(t.name, '') as stop, gp.name as guardian
     from students s
     join vehicles v on v.id = s.vehicle_id
     left join stops t on t.id = s.stop_id
     join user_profile gp on gp.user_id = s.guardian_id
     where s.status <> ${LEFT} and ${sc.sql} order by s.name`,
    sc.params,
  );
  return r.rows;
}

/** A student can only join a vehicle that is in service and has a fee plan in force, otherwise no dues would ever be generated. */
async function placeable(q, v, vehicleId, period) {
  if (v.status !== E.vehicle_status.active) throw new HttpError(409, `${v.name} is not in service`);
  const plan = await q.query('select 1 from fee_plans where vehicle_id = $1 and effective_from <= $2::date', [vehicleId, monthStart(period)]);
  if (!plan.rows.length) throw new HttpError(409, `Set a monthly fee for ${v.name} first`);
}

/**
 * Onboarding. The seat limit is enforced inside the transaction with a row lock on the vehicle.
 * @param {{ name: string, cls: string, veh: string, stop: string, gname: string, email: string, phone: string }} f
 */
async function addStudent(db, u, f, period, generateDues) {
  need(u, 'students.add');
  if (u.role !== 'admin' && String(u.vehicle_id) !== f.veh) throw new HttpError(403, 'You can only add students to your own vehicle');
  const email = f.email.trim().toLowerCase();
  return db.tx(async (q) => {
    const v = (await q.query('select capacity, name, status from vehicles where id = $1 for update', [f.veh])).rows[0];
    if (!v) throw new HttpError(400, 'Choose a vehicle');
    await placeable(q, v, f.veh, period);
    if (f.stop) {
      const ok = await q.query('select 1 from stops where id = $1 and vehicle_id = $2', [f.stop, f.veh]);
      if (!ok.rows.length) throw new HttpError(400, 'Choose a stop on this vehicle');
    }
    const used = (
      await q.query(`select count(*)::int as n from students where vehicle_id = $1 and status <> ${LEFT}`, [f.veh])
    ).rows[0].n;
    if (used >= v.capacity) {
      throw new HttpError(409, `${v.name} is full (${v.capacity} of ${v.capacity} seats). Choose another vehicle.`);
    }
    const found = (
      await q.query(
        `select u.id, exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and r.name = 'parent') as is_parent
         from users u where lower(u.email) = $1`,
        [email],
      )
    ).rows[0];
    if (found && !found.is_parent) throw new HttpError(409, 'This email belongs to another kind of account');
    let guardianId = found?.id;
    if (guardianId) {
      const dup = await q.query('select 1 from students where guardian_id = $1 and lower(name) = lower($2)', [
        guardianId,
        f.name,
      ]);
      if (dup.rows.length) throw new HttpError(409, 'This student is already added');
    } else {
      guardianId = (await q.query('insert into users(email, phone) values ($1,$2) returning id', [email, f.phone || null]))
        .rows[0].id;
      await q.query('insert into user_profile(user_id, name) values ($1,$2)', [guardianId, f.gname]);
      await q.query("insert into user_roles(user_id, role_id) select $1, id from roles where name = 'parent'", [guardianId]);
    }
    const sid = (
      await q.query(
        'insert into students(name, class_name, vehicle_id, stop_id, guardian_id, joined_on) values ($1,$2,$3,$4,$5,$6) returning id',
        [f.name, f.cls, f.veh, f.stop || null, guardianId, monthStart(period)],
      )
    ).rows[0].id;
    await generateDues(q, period);
    await audit(q, u.id, 'student.add', 'student', sid);
    return { id: sid };
  });
}

/**
 * Admin: move a student to another vehicle and/or stop. Fees follow the student: dues already generated keep their amount,
 * the next month uses the new vehicle's fee plan. The seat limit is enforced under a row lock, like onboarding.
 * @param {{ veh: string, stop: string }} f
 */
async function moveStudent(db, u, studentId, f, period) {
  need(u, 'students.move');
  if (!/^\d+$/.test(studentId)) throw new HttpError(404, 'Not found');
  return db.tx(async (q) => {
    const s = (await q.query('select id, vehicle_id, status from students where id = $1 for update', [studentId])).rows[0];
    if (!s || s.status === LEFT) throw new HttpError(404, 'Not found');
    const v = (await q.query('select id, name, capacity, status from vehicles where id = $1 for update', [f.veh])).rows[0];
    if (!v) throw new HttpError(400, 'Choose a vehicle');
    const same = String(s.vehicle_id) === String(f.veh);
    if (!same) {
      await placeable(q, v, f.veh, period);
      const used = (await q.query(`select count(*)::int as n from students where vehicle_id = $1 and status <> ${LEFT}`, [f.veh])).rows[0].n;
      if (used >= v.capacity) throw new HttpError(409, `${v.name} is full (${v.capacity} of ${v.capacity} seats). Choose another vehicle.`);
    }
    if (f.stop && !(await q.query('select 1 from stops where id = $1 and vehicle_id = $2', [f.stop, f.veh])).rows.length) {
      throw new HttpError(400, 'Choose a stop on this vehicle');
    }
    await q.query('update students set vehicle_id = $2, stop_id = $3, updated_at = now() where id = $1', [studentId, f.veh, f.stop || null]);
    await audit(q, u.id, 'student.move', 'student', studentId, `vehicle ${s.vehicle_id} -> ${f.veh}`);
  });
}

module.exports = { listVehicles, listStops, listStudents, addStudent, moveStudent, ACTIVE };
