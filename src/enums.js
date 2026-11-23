'use strict';
/**
 * Numeric values of the enum_master options (db/vandesk_schema.sql).
 * Ids are 1,2,3... per master_name in the order they are inserted. test/schema.test.js fails if this file and the database drift apart.
 */
const E = {
  user_status: { active: 1, suspended: 2, deleted: 3 },
  vehicle_status: { active: 1, inactive: 2 },
  student_status: { active: 1, paused: 2, left: 3 },
  trip_direction: { pickup: 1, drop: 2 },
  trip_status: { started: 1, ended: 2 },
  trip_event_kind: { boarded: 1, skipped: 2 },
  location_flag: { no_fix: 1, low_accuracy: 2 },
  payment_kind: { payment: 1, reversal: 2 },
  payment_mode: { cash: 1, upi: 2, other: 3 },
  notification_channel: { email: 1 },
  notification_template: { receipt: 1, reminder: 2, invite: 3 },
  notification_status: { queued: 1, sent: 2, failed: 3 },
};

/** id -> option name, e.g. name('payment_mode', 2) === 'upi' */
const name = (master, id) => Object.keys(E[master]).find((k) => E[master][k] === Number(id));

module.exports = { E, name };
