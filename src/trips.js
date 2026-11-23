'use strict';
const { E, name } = require('./enums');
const { HttpError } = require('./errors');
const { need } = require('./auth');
const { forbidden, visibleStudent } = require('./access');
const { ist, istTime } = require('./time');

const ACTIVE = E.student_status.active;
const dirId = (d) => E.trip_direction[d];
/** Parents may change until 05:00 for the morning run (the driver checks in the morning, not at midnight) and until noon for the drop. */
const cutoff = (dir) => (dir === 'pickup' ? '05:00' : '12:00');

async function getTrip(q, vehicleId, date, dir) {
  return (
    await q.query('select id, status, started_at, ended_at from trips where vehicle_id = $1 and trip_date = $2::date and direction = $3', [vehicleId, date, dirId(dir)])
  ).rows[0];
}
const tripStatus = (t) => (t ? name('trip_status', t.status) : 'idle');

const myVehicle = (u) => {
  need(u, 'trip.run');
  if (!u.vehicle_id) throw forbidden();
  return u.vehicle_id;
};

/** Driver screen: the day's students in route order (the drop run visits the route in reverse). */
async function tripView(q, u, dir, now) {
  const vid = myVehicle(u);
  const date = ist(now).date;
  const t = await getTrip(q, vid, date, dir);
  const sign = dir === 'pickup' ? 1 : -1;
  const rows = (
    await q.query(
      `select s.id::text as id, s.name, coalesce(st.name, '') as stop, st.seq, e.kind, e.event_at, ai.going, ai.is_late
       from students s
       left join stops st on st.id = s.stop_id
       left join trip_events e on e.trip_id = $4 and e.student_id = s.id
       left join attendance_intents ai on ai.student_id = s.id and ai.trip_date = $2::date and ai.direction = $3
       where s.vehicle_id = $1 and s.status = ${ACTIVE}`,
      [vid, date, dirId(dir), t?.id ?? null],
    )
  ).rows;
  rows.sort((a, b) => sign * ((a.seq ?? 99) - (b.seq ?? 99)) || a.name.localeCompare(b.name));
  return {
    direction: dir,
    state: { status: tripStatus(t), startedAt: istTime(t?.started_at), endedAt: istTime(t?.ended_at) },
    roster: rows.map((r) => ({
      id: r.id,
      name: r.name,
      stop: r.stop,
      seq: r.seq ?? 99,
      state: r.going === false ? 'off' : r.kind ? name('trip_event_kind', r.kind) : 'wait',
      at: istTime(r.event_at),
      late: !!r.is_late,
    })),
  };
}

async function tripStart(q, u, dir, now) {
  const vid = myVehicle(u);
  const t = await getTrip(q, vid, ist(now).date, dir);
  if (t?.status === E.trip_status.started) return; // resume
  if (t) {
    await q.query('delete from trip_events where trip_id = $1', [t.id]);
    await q.query(`update trips set status = ${E.trip_status.started}, started_at = $2, ended_at = null, started_by = $3 where id = $1`, [t.id, now.toISOString(), u.id]);
  } else {
    await q.query(`insert into trips(vehicle_id, trip_date, direction, status, started_at, started_by) values ($1,$2::date,$3,${E.trip_status.started},$4,$5)`, [vid, ist(now).date, dirId(dir), now.toISOString(), u.id]);
  }
}

/** Never blocked, even with unmarked students. */
async function tripEnd(q, u, dir, now) {
  const vid = myVehicle(u);
  await q.query(`update trips set status = ${E.trip_status.ended}, ended_at = $4 where vehicle_id = $1 and trip_date = $2::date and direction = $3`, [vid, ist(now).date, dirId(dir), now.toISOString()]);
}

/** One tap per student, tap again = undo. Location is captured only here; a missing fix never blocks the tap. */
async function tripTap(db, u, f, now) {
  const vid = myVehicle(u);
  return db.tx(async (q) => {
    const s = /^\d+$/.test(f.studentId) ? (await q.query('select vehicle_id from students where id = $1', [f.studentId])).rows[0] : null;
    if (!s || String(s.vehicle_id) !== String(vid)) throw forbidden();
    const date = ist(now).date;
    const t = await getTrip(q, vid, date, f.direction);
    if (t?.status !== E.trip_status.started) throw new HttpError(409, 'Start the trip first');
    const intent = (
      await q.query('select going from attendance_intents where student_id = $1 and trip_date = $2::date and direction = $3', [f.studentId, date, dirId(f.direction)])
    ).rows[0];
    if (intent && !intent.going) return { state: 'off' };
    const ex = (await q.query('select id, kind from trip_events where trip_id = $1 and student_id = $2', [t.id, f.studentId])).rows[0];
    const kind = E.trip_event_kind[f.kind];
    if (ex) {
      await q.query('delete from trip_events where id = $1', [ex.id]);
      if (ex.kind === kind) return { state: 'wait' };
    }
    const hasFix = typeof f.lat === 'number' && typeof f.lng === 'number';
    const flag = !hasFix ? E.location_flag.no_fix : (f.accuracy ?? 0) > 100 ? E.location_flag.low_accuracy : null;
    await q.query(
      'insert into trip_events(trip_id, student_id, kind, event_at, lat, lng, accuracy, flag) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [t.id, f.studentId, kind, now.toISOString(), hasFix ? f.lat : null, hasFix ? f.lng : null, f.accuracy ?? null, flag],
    );
    return { state: f.kind };
  });
}

async function children(q, u) {
  need(u, 'attendance.set');
  return (await q.query(`select id::text as id, name from students where guardian_id = $1 and status = ${ACTIVE} order by name`, [u.id])).rows;
}

const r3 = (n) => Math.round(n * 1000) / 1000; // about 100 m: parents never see an exact position

async function parentTrip(q, u, sid, dir, now) {
  need(u, 'attendance.set');
  const s = await visibleStudent(q, u, sid);
  const date = ist(now).date;
  const t = await getTrip(q, s.vehicle_id, date, dir);
  const sign = dir === 'pickup' ? 1 : -1;
  const ord = (seq) => sign * seq;
  const stops = (
    await q.query("select id, name, seq, coalesce(to_char(typical_time, 'HH24:MI'), '') as typical from stops where vehicle_id = $1 order by seq", [s.vehicle_id])
  ).rows;
  stops.sort((a, b) => ord(a.seq) - ord(b.seq));
  const my = stops.find((x) => x.id === s.stop_id);
  const ev = t
    ? (
        await q.query(
          `select e.student_id, e.event_at, st.seq, st.name as stop, e.lat, e.lng, e.accuracy
           from trip_events e join students x on x.id = e.student_id left join stops st on st.id = x.stop_id
           where e.trip_id = $1 and e.kind = ${E.trip_event_kind.boarded} order by e.event_at`,
          [t.id],
        )
      ).rows
    : [];
  const last = ev[ev.length - 1];
  const progress = ev.reduce((m, e) => Math.max(m, ord(e.seq ?? 0)), -Infinity);
  const me = ev.find((e) => String(e.student_id) === String(sid));
  const away = my ? ord(my.seq) - progress - 1 : -1;
  const status = tripStatus(t);
  const intent = (
    await q.query('select going from attendance_intents where student_id = $1 and trip_date = $2::date and direction = $3', [sid, date, dirId(dir)])
  ).rows[0];
  const fix = last && last.lat != null && last.lng != null && (last.accuracy ?? 0) <= 100 ? { lat: r3(last.lat), lng: r3(last.lng) } : undefined;
  return {
    direction: dir,
    going: intent ? intent.going : true,
    locked: !!t,
    status,
    picked: istTime(me?.event_at),
    typical: my?.typical ?? '',
    away:
      status === 'started' && !me && away >= 0 && ev.length > 0
        ? away
        : status === 'started' && !me && ev.length === 0
          ? Math.max(0, ord(my?.seq ?? 1) - 1)
          : null,
    last: last ? { stop: last.stop ?? '', at: istTime(last.event_at) ?? '' } : undefined,
    pin: fix,
    stops: stops.map((x) => ({
      name: x.name,
      done: !!t && progress !== -Infinity && ord(x.seq) <= progress,
      mine: x.id === s.stop_id,
      typical: x.typical,
    })),
  };
}

/** Parent says Going / Not going. Locked once the trip starts; after the cutoff it is accepted but flagged late for the driver. */
async function setGoing(q, u, sid, going, dir, now) {
  need(u, 'attendance.set');
  const s = await visibleStudent(q, u, sid);
  const t = ist(now);
  if (await getTrip(q, s.vehicle_id, t.date, dir)) throw new HttpError(409, 'Trip already started. Please call the driver.');
  const late = t.time > cutoff(dir);
  await q.query(
    `insert into attendance_intents(student_id, trip_date, direction, going, is_late, set_at) values ($1,$2::date,$3,$4,$5,$6)
     on conflict (student_id, trip_date, direction) do update set going = $4, is_late = $5, set_at = $6`,
    [sid, t.date, dirId(dir), going, late, now.toISOString()],
  );
  return { late };
}

/** Raw coordinates are removed after 90 days; the events stay. */
async function retention(q, now) {
  const cut = new Date(now.getTime() - 90 * 86400000).toISOString();
  const r = await q.query('update trip_events set lat = null, lng = null, accuracy = null where event_at < $1 and lat is not null returning id', [cut]);
  return { cleared: r.rows.length };
}

module.exports = { tripView, tripStart, tripEnd, tripTap, children, parentTrip, setGoing, retention };
