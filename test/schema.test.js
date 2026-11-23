'use strict';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { E } = require('../src/enums');
const { boot } = require('./helpers');

let t;
before(async () => { t = await boot(new Date('2026-11-02T03:30:00Z')); });
after(() => t.close());

describe('db/vandesk_schema.sql', () => {
  it('enum_master matches src/enums.js exactly', async () => {
    const rows = (await t.db.query('select master_name, option_name, id::int as id from enum_master')).rows;
    const fromDb = Object.fromEntries(Object.keys(E).map((m) => [m, {}]));
    for (const r of rows) (fromDb[r.master_name] ??= {})[r.option_name] = r.id;
    assert.deepEqual(fromDb, E);
  });
  it('seeds the three system roles', async () => {
    const r = await t.db.query('select name from roles where is_system order by name');
    assert.deepEqual(r.rows.map((x) => x.name), ['admin', 'driver', 'parent']);
  });
  it('running it a second time is refused by Postgres (one-shot script, like the Resello one)', async () => {
    const { SCHEMA_FILE } = require('../src/db');
    const sql = require('node:fs').readFileSync(SCHEMA_FILE, 'utf8');
    await assert.rejects(() => t.db.query('select 1').then(() => t.db.query(sql)));
  });
  it('enforces the money rules in the database itself', async () => {
    const q = (s, p) => t.db.query(s, p);
    await assert.rejects(() => q("insert into payments(student_id, kind, amount, mode, paid_on) values (1, 1, 0, 1, '2026-11-02')"), /check/i); // amount > 0
    await assert.rejects(() => q("insert into payments(student_id, kind, amount, mode, paid_on) values (1, 2, 100, 1, '2026-11-02')"), /check/i); // a reversal must point at a payment
    await assert.rejects(() => q("insert into fee_dues(student_id, due_month, amount) values (1, '2026-11-15', 100)"), /check/i); // first of month only
    const pay = (await q("insert into payments(student_id, kind, amount, mode, paid_on) values (1, 1, 100, 1, '2026-11-02') returning id")).rows[0].id;
    await q("insert into payments(student_id, kind, amount, mode, paid_on, reversal_of) values (1, 2, 100, 1, '2026-11-02', $1)", [pay]);
    await assert.rejects(() => q("insert into payments(student_id, kind, amount, mode, paid_on, reversal_of) values (1, 2, 100, 1, '2026-11-02', $1)", [pay]), /unique/i); // reversed at most once
  });
});
