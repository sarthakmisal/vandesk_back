'use strict';
const { HttpError } = require('./errors');

const forbidden = () => new HttpError(403, 'Not allowed');

/** Read scope as SQL: admin all, driver own vehicle, parent own children. `idx` is the first free $n. */
function scope(u, alias, idx) {
  if (u.role === 'admin') return { sql: 'true', params: [] };
  return u.role === 'driver'
    ? { sql: `${alias}.vehicle_id = $${idx}`, params: [u.vehicle_id] }
    : { sql: `${alias}.guardian_id = $${idx}`, params: [u.id] };
}

/** The student, or 403 when this user may not see them. */
async function visibleStudent(q, u, sid) {
  if (!/^\d+$/.test(String(sid))) throw forbidden();
  const sc = scope(u, 's', 2);
  const r = await q.query(
    `select s.id, s.name, s.vehicle_id, s.guardian_id, s.stop_id from students s where s.id = $1 and ${sc.sql}`,
    [sid, ...sc.params],
  );
  if (!r.rows[0]) throw forbidden();
  return r.rows[0];
}

const audit = (q, actor, action, entity, id, detail = '') =>
  q.query('insert into audit_logs(actor_id, action, entity, entity_id, detail) values ($1,$2,$3,$4,$5)', [
    actor,
    action,
    entity,
    id,
    detail,
  ]);

module.exports = { forbidden, scope, visibleStudent, audit };
