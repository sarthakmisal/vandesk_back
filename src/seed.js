'use strict';
const fees = require('./fees');
const { ist } = require('./time');

/** Demo data (same people as the frontend demo): 2 vehicles, 2 drivers, 6 guardians, 7 students, fee Rs 300/month from June 2026. */
async function seedDemo(db, now) {
  if ((await db.query('select count(*)::int as n from users')).rows[0].n > 0) return false;
  await db.tx(async (q) => {
    const role = async (name) => (await q.query('select id from roles where name = $1', [name])).rows[0].id;
    const person = async (email, name, roleName, phone = null) => {
      const uid = (await q.query('insert into users(email, phone, is_verified) values ($1,$2,true) returning id', [email, phone])).rows[0].id;
      await q.query('insert into user_profile(user_id, name) values ($1,$2)', [uid, name]);
      await q.query('insert into user_roles(user_id, role_id) values ($1,$2)', [uid, await role(roleName)]);
      return uid;
    };
    await person('admin@vandesk.test', 'VanDesk Admin', 'admin');
    const ramesh = await person('ramesh@vandesk.test', 'Ramesh Kale', 'driver', '9820000001');
    const suresh = await person('suresh@vandesk.test', 'Suresh Wagh', 'driver', '9820000002');

    const van = (await q.query("insert into vehicles(name, reg_no, capacity, driver_id) values ('Van','MH-20 AB 1234',6,$1) returning id", [ramesh])).rows[0].id;
    const bus = (await q.query("insert into vehicles(name, reg_no, capacity, driver_id) values ('Mini bus','MH-20 CD 5678',14,$1) returning id", [suresh])).rows[0].id;

    const stop = async (v, name, seq, time) => (await q.query('insert into stops(vehicle_id, name, seq, typical_time) values ($1,$2,$3,$4) returning id', [v, name, seq, time])).rows[0].id;
    const t1 = await stop(van, 'Hanuman Mandir', 1, '07:05');
    const t2 = await stop(van, 'Ganpati Mandir', 2, '07:15');
    const t3 = await stop(van, 'Garden Chowk', 3, '07:25');
    await stop(van, 'Bus Stand', 4, '07:35');
    const t5 = await stop(bus, 'Station Road', 1, '07:10');
    const t6 = await stop(bus, 'Market Yard', 2, '07:25');

    await q.query("insert into fee_plans(vehicle_id, amount, effective_from) values ($1,30000,'2026-06-01'), ($2,30000,'2026-06-01')", [van, bus]);

    const guardians = {};
    for (const [i, g] of ['Mr. Patil', 'Mrs. Joshi', 'Mrs. Kulkarni', 'Mrs. More', 'Mrs. Naik', 'Mr. Sinha'].entries()) {
      guardians[i + 1] = await person(g.replace(/\W+/g, '').toLowerCase() + '@mail.test', g, 'parent', `9820000${100 + i}`);
    }
    const kids = [
      ['Akshay Patil', '5', van, t1, 1, '2026-06-01'],
      ['Ishita Patil', '3', van, t1, 1, '2026-06-01'],
      ['Karthik Joshi', '6', van, t2, 2, '2026-06-01'],
      ['Harsha Kulkarni', '7', van, t3, 3, '2026-08-01'],
      ['Rohan More', '8', van, t3, 4, '2026-06-01'],
      ['Diya Naik', '4', bus, t5, 5, '2026-06-01'],
      ['Kabir Sinha', '6', bus, t6, 6, '2026-07-01'],
    ];
    const ids = [];
    for (const [name, cls, v, st, g, joined] of kids) {
      ids.push((await q.query('insert into students(name, class_name, vehicle_id, stop_id, guardian_id, joined_on) values ($1,$2,$3,$4,$5,$6) returning id', [name, cls, v, st, guardians[g], joined])).rows[0].id);
    }

    // backfill dues from June 2026 up to the current month, then record a few payments
    const cur = ist(now).period;
    for (let y = 2026, m = 6; `${y}-${String(m).padStart(2, '0')}` <= cur; m === 12 ? (y++, (m = 1)) : m++) {
      await fees.generateDues(q, `${y}-${String(m).padStart(2, '0')}`);
    }
    for (const [i, amt] of [[0, 150000], [1, 60000], [2, 90000], [3, 30000], [5, 120000]]) {
      await fees.applyPayment(q, ids[i], amt, 'cash', '2026-09-12', ramesh, null);
    }
  });
  return true;
}

module.exports = { seedDemo };
