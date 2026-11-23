'use strict';
const { E } = require('./enums');
const { HttpError } = require('./errors');
const { need } = require('./auth');
const { audit } = require('./access');
const { collectedToday } = require('./fees');
const { ist, monthStart } = require('./time');

const ACTIVE_V = E.vehicle_status.active;
const LEFT = E.student_status.left;

/** VanDesk team: platform numbers and driver access. No daily operations. */
async function adminOverview(q, u, now) {
  need(u, 'admin.view');
  const date = ist(now).date;
  const vehicles = (
    await q.query(
      `select v.id::text as id, v.name || ' · ' || v.reg_no as label, v.name, v.reg_no as reg, v.capacity as cap,
              (v.status = ${ACTIVE_V}) as "inService",
              coalesce(dr.id::text, '') as "driverId", coalesce(dp.name, '') as driver, coalesce(dr.email, '') as "driverEmail",
              coalesce(dr.status = ${E.user_status.active}, false) as active,
              (select p.amount from fee_plans p where p.vehicle_id = v.id and p.effective_from <= $1::date order by p.effective_from desc limit 1) as fee,
              (select count(*)::int from stops st where st.vehicle_id = v.id) as stops,
              (select count(*)::int from students s where s.vehicle_id = v.id and s.status <> ${LEFT}) as used,
              (select coalesce(sum(b.outstanding), 0)::int from fee_due_balances b join students s2 on s2.id = b.student_id where s2.vehicle_id = v.id) as outstanding,
              coalesce((select case when bool_or(t.status = ${E.trip_status.started}) then 'started' when bool_or(t.status = ${E.trip_status.ended}) then 'ended' end
                        from trips t where t.vehicle_id = v.id and t.trip_date = $1::date), 'idle') as trip
       from vehicles v
       left join users dr on dr.id = v.driver_id
       left join user_profile dp on dp.user_id = dr.id
       order by (v.status <> ${ACTIVE_V}), v.id`,
      [date],
    )
  ).rows;
  const students = (await q.query(`select count(*)::int as n from students where status <> ${E.student_status.left}`)).rows[0].n;
  return { students, outstanding: vehicles.reduce((x, v) => x + v.outstanding, 0), collected: await collectedToday(q, u, date), vehicles };
}

/** Suspend or re-activate a driver (users.status). A suspended driver is signed out on the next request. */
async function setDriverActive(q, u, driverId, active) {
  need(u, 'drivers.manage');
  const r = /^\d+$/.test(driverId)
    ? await q.query(
        `update users set status = $2, updated_at = now()
         where id = $1 and status <> ${E.user_status.deleted}
           and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = users.id and r.name = 'driver')
         returning id`,
        [driverId, active ? E.user_status.active : E.user_status.suspended],
      )
    : { rows: [] };
  if (!r.rows[0]) throw new HttpError(404, 'Not found');
  await audit(q, u.id, active ? 'driver.activate' : 'driver.suspend', 'user', driverId);
}

/* ---------------------------------------------------------------- vehicles */

const regNo = (s) => s.trim().toUpperCase().replace(/\s+/g, ' ');
const isId = (x) => /^\d+$/.test(String(x));

async function lockVehicle(q, vehicleId) {
  const v = isId(vehicleId) ? (await q.query('select * from vehicles where id = $1 for update', [vehicleId])).rows[0] : undefined;
  if (!v) throw new HttpError(404, 'Not found');
  return v;
}

async function regTaken(q, reg, exceptId) {
  const r = await q.query('select 1 from vehicles where reg_no = $1 and id <> coalesce($2::bigint, 0)', [reg, exceptId ?? null]);
  if (r.rows.length) throw new HttpError(409, 'A vehicle with this registration number already exists');
}

/** Driver account for a vehicle: an existing driver without a vehicle is re-used, otherwise one is created. Sign-in is by email OTP. */
async function claimDriver(q, vehicleId, name, emailRaw) {
  const email = emailRaw.trim().toLowerCase();
  const found = (
    await q.query(
      `select u.id, u.status,
              (select array_agg(r.name) from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id) as roles
       from users u where lower(u.email) = $1`,
      [email],
    )
  ).rows[0];
  if (!found) {
    const id = (await q.query('insert into users(email) values ($1) returning id', [email])).rows[0].id;
    await q.query('insert into user_profile(user_id, name) values ($1,$2)', [id, name]);
    await q.query("insert into user_roles(user_id, role_id) select $1, id from roles where name = 'driver'", [id]);
    return id;
  }
  if (found.status === E.user_status.deleted || found.roles?.join() !== 'driver') {
    throw new HttpError(409, 'This email belongs to another kind of account');
  }
  const other = (await q.query('select name from vehicles where driver_id = $1 and id <> $2', [found.id, vehicleId])).rows[0];
  if (other) throw new HttpError(409, `This driver already drives ${other.name}`);
  await q.query(`update users set status = ${E.user_status.active}, updated_at = now() where id = $1`, [found.id]);
  return found.id;
}

/** A driver without a vehicle has nothing to do, so the account is suspended (assigning the same email to a bus later re-activates it). */
const parkDriver = (q, driverId) =>
  driverId ? q.query(`update users set status = ${E.user_status.suspended}, updated_at = now() where id = $1`, [driverId]) : undefined;

/**
 * Onboard a bus: vehicle, driver, the first monthly fee (required: without a plan no dues are generated) and optionally its stops in route order.
 * @param {{ name: string, regNo: string, capacity: number, fee: number, driverName: string, driverEmail: string, stops: string[] }} f
 */
async function addVehicle(db, u, f, period) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const reg = regNo(f.regNo);
    await regTaken(q, reg);
    const id = (await q.query('insert into vehicles(name, reg_no, capacity) values ($1,$2,$3) returning id', [f.name, reg, f.capacity])).rows[0].id;
    const driver = await claimDriver(q, id, f.driverName, f.driverEmail);
    await q.query('update vehicles set driver_id = $2 where id = $1', [id, driver]);
    await q.query('insert into fee_plans(vehicle_id, amount, effective_from, created_by) values ($1,$2,$3,$4)', [id, f.fee, monthStart(period), u.id]);
    for (const [i, stop] of f.stops.entries()) await q.query('insert into stops(vehicle_id, name, seq) values ($1,$2,$3)', [id, stop, i + 1]);
    await audit(q, u.id, 'vehicle.add', 'vehicle', id, reg);
    return { id };
  });
}

/** @param {{ name?: string, regNo?: string, capacity?: number }} f */
async function updateVehicle(db, u, vehicleId, f) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const v = await lockVehicle(q, vehicleId);
    const reg = f.regNo === undefined ? v.reg_no : regNo(f.regNo);
    if (reg !== v.reg_no) await regTaken(q, reg, v.id);
    const cap = f.capacity ?? v.capacity;
    const used = (await q.query(`select count(*)::int as n from students where vehicle_id = $1 and status <> ${LEFT}`, [v.id])).rows[0].n;
    if (cap < used) throw new HttpError(409, `${used} students ride this vehicle. Move some first or keep at least ${used} seats.`);
    await q.query('update vehicles set name = $2, reg_no = $3, capacity = $4, updated_at = now() where id = $1', [v.id, f.name ?? v.name, reg, cap]);
    await audit(q, u.id, 'vehicle.update', 'vehicle', v.id);
  });
}

/** Retire a vehicle (it must be empty) or bring it back into service. A retired vehicle loses its driver; assign one again after restoring. */
async function setVehicleInService(db, u, vehicleId, inService) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const v = await lockVehicle(q, vehicleId);
    if (inService) {
      await q.query(`update vehicles set status = ${ACTIVE_V}, updated_at = now() where id = $1`, [v.id]);
    } else {
      const used = (await q.query(`select count(*)::int as n from students where vehicle_id = $1 and status <> ${LEFT}`, [v.id])).rows[0].n;
      if (used) throw new HttpError(409, `Move the ${used} student${used === 1 ? '' : 's'} to another vehicle first`);
      await q.query(`update vehicles set status = ${E.vehicle_status.inactive}, driver_id = null, updated_at = now() where id = $1`, [v.id]);
      await parkDriver(q, v.driver_id);
    }
    await audit(q, u.id, inService ? 'vehicle.restore' : 'vehicle.retire', 'vehicle', v.id);
  });
}

/** Replace the driver of a vehicle. The previous driver is suspended (no vehicle, no access). */
async function changeDriver(db, u, vehicleId, f) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const v = await lockVehicle(q, vehicleId);
    if (v.status !== ACTIVE_V) throw new HttpError(409, 'Restore this vehicle first');
    await q.query('update vehicles set driver_id = null where id = $1', [v.id]);
    const next = await claimDriver(q, v.id, f.name, f.email);
    await q.query('update vehicles set driver_id = $2, updated_at = now() where id = $1', [v.id, next]);
    if (v.driver_id && String(v.driver_id) !== String(next)) await parkDriver(q, v.driver_id);
    await audit(q, u.id, 'vehicle.driver', 'vehicle', v.id, String(next));
  });
}

/* ------------------------------------------------------------------- stops */

async function lockStop(q, stopId) {
  const s = isId(stopId) ? (await q.query('select id, vehicle_id, seq from stops where id = $1 for update', [stopId])).rows[0] : undefined;
  if (!s) throw new HttpError(404, 'Not found');
  return s;
}

/** Appended at the end of the route; reorder with moveStop. @param {{ name: string, typical: string }} f */
async function addStop(db, u, vehicleId, f) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const v = await lockVehicle(q, vehicleId);
    const id = (
      await q.query(
        `insert into stops(vehicle_id, name, seq, typical_time)
         select $1, $2, coalesce(max(seq), 0) + 1, nullif($3, '')::time from stops where vehicle_id = $1 returning id`,
        [v.id, f.name, f.typical ?? ''],
      )
    ).rows[0].id;
    await audit(q, u.id, 'stop.add', 'stop', id);
    return { id };
  });
}

/** @param {{ name?: string, typical?: string }} f */
async function updateStop(db, u, stopId, f) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const s = await lockStop(q, stopId);
    await q.query(
      `update stops set name = coalesce($2, name), typical_time = case when $3::text is null then typical_time else nullif($3, '')::time end where id = $1`,
      [s.id, f.name ?? null, f.typical ?? null],
    );
    await audit(q, u.id, 'stop.update', 'stop', s.id);
  });
}

/** Swap with the neighbour. The route order (and so the next-student order on the driver's screen) follows `seq`. */
async function moveStop(db, u, stopId, direction) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const s = await lockStop(q, stopId);
    const nb = (
      await q.query(
        direction === 'up'
          ? 'select id, seq from stops where vehicle_id = $1 and seq < $2 order by seq desc limit 1'
          : 'select id, seq from stops where vehicle_id = $1 and seq > $2 order by seq limit 1',
        [s.vehicle_id, s.seq],
      )
    ).rows[0];
    if (!nb) return;
    // (vehicle_id, seq) is unique, so park one of them on a negative number while swapping
    await q.query('update stops set seq = -seq where id = $1', [s.id]);
    await q.query('update stops set seq = $2 where id = $1', [nb.id, s.seq]);
    await q.query('update stops set seq = $2 where id = $1', [s.id, nb.seq]);
    await audit(q, u.id, 'stop.move', 'stop', s.id, direction);
  });
}

/** Only an unused stop can be removed: a student never silently loses his pickup point. */
async function deleteStop(db, u, stopId) {
  need(u, 'vehicles.manage');
  return db.tx(async (q) => {
    const s = await lockStop(q, stopId);
    const n = (await q.query(`select count(*)::int as n from students where stop_id = $1 and status <> ${LEFT}`, [s.id])).rows[0].n;
    if (n) throw new HttpError(409, `${n} student${n === 1 ? ' uses' : 's use'} this stop. Move ${n === 1 ? 'him' : 'them'} first.`);
    await q.query('delete from stops where id = $1', [s.id]);
    await audit(q, u.id, 'stop.delete', 'stop', s.id);
  });
}

module.exports = { adminOverview, setDriverActive, addVehicle, updateVehicle, setVehicleInService, changeDriver, addStop, updateStop, moveStop, deleteStop };
