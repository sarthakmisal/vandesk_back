'use strict';
const { createHash, createHmac, randomInt, timingSafeEqual } = require('node:crypto');
const { HttpError } = require('./errors');
const { E } = require('./enums');

/** Keep in sync with the frontend (src/app/core/auth.service.ts). The server is the real security boundary. */
const PERMS = {
  admin: ['admin.view', 'drivers.manage', 'vehicles.manage', 'students.read', 'students.add', 'students.move', 'fees.read', 'fees.plan'],
  driver: ['fees.read', 'fees.record', 'students.read', 'students.add', 'trip.run'],
  parent: ['fees.read', 'attendance.set'],
};

/**
 * One row per user: name, highest role (admin > driver > parent) and the vehicle they drive.
 * @param {'u.id' | 'LOWER(u.email)'} by
 */
const userSql = (by) => `
  select u.id, u.email, p.name, r.name as role, v.id as vehicle_id, (u.status = ${E.user_status.active}) as active
  from users u
  join user_profile p on p.user_id = u.id
  join user_roles ur on ur.user_id = u.id
  join roles r on r.id = ur.role_id
  left join vehicles v on v.driver_id = u.id
  where ${by} = $1 and u.status <> ${E.user_status.deleted}
  order by case r.name when 'admin' then 1 when 'driver' then 2 else 3 end
  limit 1`;
const USER_BY_ID = userSql('u.id');
const USER_BY_EMAIL = userSql('LOWER(u.email)');

function need(u, perm) {
  if (!PERMS[u.role].includes(perm)) throw new HttpError(403, 'Not allowed');
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sig = (secret, body) => createHmac('sha256', secret).update(body).digest('base64url');

/** Long-lived sessions so drivers do not sign in daily: driver/admin 30 days, parent 90 days. */
function signToken(secret, u, now) {
  const days = u.role === 'parent' ? 90 : 30;
  const body = b64(JSON.stringify({ uid: String(u.id), exp: now.getTime() + days * 86400000 }));
  return `${body}.${sig(secret, body)}`;
}

/** @returns {string|null} user id */
function verifyToken(secret, token, now) {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sig(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > now.getTime() ? String(p.uid) : null;
  } catch {
    return null;
  }
}

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const hashCode = (secret, email, code) => createHash('sha256').update(`${secret}:${email}:${code}`).digest('hex');

module.exports = { PERMS, USER_BY_ID, USER_BY_EMAIL, need, signToken, verifyToken, newCode, hashCode };
