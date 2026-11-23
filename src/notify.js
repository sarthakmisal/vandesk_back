'use strict';
const { E } = require('./enums');
const { tpl } = require('./mail');
const { ist } = require('./time');

const ACTIVE = E.student_status.active;

/** One log row per dedupe key, written before sending: the same key is never sent twice. */
async function sendLogged(db, mail, m) {
  const ins = await db.query(
    `insert into notifications(user_id, student_id, template, dedupe_key, subject, body) values ($1,$2,$3,$4,$5,$6)
     on conflict (dedupe_key) do nothing returning id`,
    [m.userId, m.studentId, E.notification_template[m.template], m.key, m.subject, m.text],
  );
  if (!ins.rows[0]) return 'skipped';
  try {
    await mail.send(m.to, m.subject, m.text);
    await db.query(`update notifications set status = ${E.notification_status.sent}, attempts = attempts + 1, sent_at = now() where id = $1`, [ins.rows[0].id]);
    return 'sent';
  } catch (e) {
    await db.query(`update notifications set status = ${E.notification_status.failed}, attempts = attempts + 1, error = $2 where id = $1`, [ins.rows[0].id, String(e)]);
    return 'failed';
  }
}

const guardianOf = async (db, studentId) =>
  (
    await db.query(
      `select gp.name as gname, g.email, g.id as gid, s.name as sname
       from students s join users g on g.id = s.guardian_id join user_profile gp on gp.user_id = g.id where s.id = $1`,
      [studentId],
    )
  ).rows[0];

async function mailReceipt(db, mail, paymentId, studentId, amount, balance, date) {
  const g = await guardianOf(db, studentId);
  if (g) {
    await sendLogged(db, mail, { to: g.email, userId: g.gid, studentId, template: 'receipt', key: `receipt:${paymentId}`, ...tpl.receipt(g.gname, g.sname, amount, date, balance) });
  }
}

async function mailInvite(db, mail, studentId) {
  const g = await guardianOf(db, studentId);
  if (g) {
    await sendLogged(db, mail, { to: g.email, userId: g.gid, studentId, template: 'invite', key: `invite:${studentId}`, ...tpl.invite(g.gname, g.sname) });
  }
}

const reminderDay = (day) => [1, 5, 10, 15].includes(day) || (day > 15 && (day - 15) % 7 === 0);

/**
 * Fee reminders, 1:1 to the guardian, at most one per student per day.
 * Scheduled run: only on reminder days and inside the 09:00-20:00 IST window. Manual run (driver button): any time.
 */
async function sendReminders(db, mail, now, opts) {
  const t = ist(now);
  if (!opts.manual && !(reminderDay(t.day) && t.hour >= 9 && t.hour < 20)) {
    return { sent: 0, skipped: 0, failed: 0, note: 'Not a reminder day or outside the send window' };
  }
  const r = await db.query(
    `select s.id, s.name, g.id as gid, gp.name as gname, g.email, sum(b.outstanding)::int as bal
     from students s
     join users g on g.id = s.guardian_id
     join user_profile gp on gp.user_id = g.id
     join fee_due_balances b on b.student_id = s.id
     where s.status = ${ACTIVE} and ($1::bigint is null or s.vehicle_id = $1::bigint)
     group by s.id, g.id, gp.name having sum(b.outstanding) > 0 order by s.name`,
    [opts.vehicle ?? null],
  );
  const out = { sent: 0, skipped: 0, failed: 0, note: '' };
  for (const x of r.rows) {
    const res = await sendLogged(db, mail, { to: x.email, userId: x.gid, studentId: x.id, template: 'reminder', key: `rem:${x.id}:${t.date}`, ...tpl.reminder(x.gname, x.name, x.bal) });
    out[res] += 1;
  }
  return out;
}

module.exports = { mailReceipt, mailInvite, sendReminders };
