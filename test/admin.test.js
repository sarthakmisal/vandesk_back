'use strict';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { boot } = require('./helpers');

// 2026-11-02 09:00 IST (Monday)
const MON = new Date('2026-11-02T03:30:00Z');
let t, call, T;
let bus3; // the vehicle onboarded below

before(async () => {
  t = await boot(MON);
  call = t.call;
  T = {
    admin: await t.signIn('admin@vandesk.test'),
    van: await t.signIn('ramesh@vandesk.test'),
    patil: await t.signIn('mrpatil@mail.test'),
  };
});
after(() => t.close());

const newBus = (over = {}) => ({
  name: 'Mini van',
  regNo: 'mh-20  ef 9012',
  capacity: 2,
  fee: 25000,
  driverName: 'Anil More',
  driverEmail: 'Anil@Vandesk.test',
  stops: ['Temple Road', 'Lake View', 'School Gate'],
  ...over,
});
const overview = async () => (await call(T.admin, 'GET', '/admin/overview')).body;

describe('admin: onboard a bus', () => {
  it('creates the vehicle, driver, first fee and stops in route order', async () => {
    const r = await call(T.admin, 'POST', '/admin/vehicles', newBus());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    bus3 = r.body.id;
    const v = (await overview()).vehicles.find((x) => x.id === bus3);
    assert.equal(v.reg, 'MH-20 EF 9012'); // normalised, so duplicates cannot hide behind spacing or case
    assert.equal(v.fee, 25000);
    assert.equal(v.stops, 3);
    assert.equal(v.driver, 'Anil More');
    assert.equal(v.driverEmail, 'anil@vandesk.test');
    assert.equal(v.inService, true);
    const stops = (await call(T.admin, 'GET', `/vehicles/${bus3}/stops`)).body;
    assert.deepEqual(stops.map((s) => [s.name, s.seq]), [['Temple Road', 1], ['Lake View', 2], ['School Gate', 3]]);
  });
  it('the new driver signs in with his email and gets exactly his own vehicle', async () => {
    T.anil = await t.signIn('anil@vandesk.test');
    const me = (await call(T.anil, 'GET', '/me')).body;
    assert.equal(me.role, 'driver');
    assert.equal(me.veh, bus3);
    assert.equal((await call(T.anil, 'GET', '/vehicles')).body.length, 1);
    assert.equal((await call(T.anil, 'GET', '/vehicles/1/stops')).status, 403);
  });
  it('rejects a duplicate registration, a parent email and a driver who already has a bus', async () => {
    assert.equal((await call(T.admin, 'POST', '/admin/vehicles', newBus({ regNo: 'MH-20 EF 9012', driverEmail: 'x1@vandesk.test' }))).status, 409);
    assert.equal((await call(T.admin, 'POST', '/admin/vehicles', newBus({ regNo: 'MH-20 ZZ 1', driverEmail: 'mrpatil@mail.test' }))).status, 409);
    const busy = await call(T.admin, 'POST', '/admin/vehicles', newBus({ regNo: 'MH-20 ZZ 2', driverEmail: 'ramesh@vandesk.test' }));
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /already drives/);
    assert.equal((await call(T.admin, 'POST', '/admin/vehicles', newBus({ regNo: 'MH-20 ZZ 3', driverEmail: 'not-an-email' }))).status, 400);
    assert.equal((await call(T.admin, 'POST', '/admin/vehicles', newBus({ regNo: 'MH-20 ZZ 4', fee: 0, driverEmail: 'x2@vandesk.test' }))).status, 400);
    assert.equal((await overview()).vehicles.length, 3); // nothing half-created
  });
  it('only the admin can do any of this', async () => {
    for (const [m, p, b] of [
      ['POST', '/admin/vehicles', newBus({ regNo: 'MH-20 QQ 1', driverEmail: 'q@vandesk.test' })],
      ['PUT', '/admin/vehicles/1', { capacity: 9 }],
      ['PUT', '/admin/vehicles/1/in-service', { inService: false }],
      ['PUT', '/admin/vehicles/1/driver', { name: 'X', email: 'x@vandesk.test' }],
      ['POST', '/admin/vehicles/1/fee-plans', { amount: 100, from: '2027-01-01' }],
      ['POST', '/admin/vehicles/1/stops', { name: 'Z' }],
      ['PUT', '/admin/stops/1', { name: 'Z' }],
      ['POST', '/admin/stops/1/move', { dir: 'down' }],
      ['DELETE', '/admin/stops/1'],
      ['PUT', '/admin/students/1/placement', { veh: '2', stop: '' }],
    ]) {
      for (const who of [T.van, T.patil]) assert.equal((await call(who, m, p, b)).status, 403, `${m} ${p}`);
    }
  });
});

describe('admin: students on any bus', () => {
  it('adds a student to a bus that is not his own, generates the due at that bus fee, and enforces seats', async () => {
    const stops = (await call(T.admin, 'GET', `/vehicles/${bus3}/stops`)).body;
    const add = (name, email) => call(T.admin, 'POST', '/students', { name, cls: '4', veh: bus3, stop: stops[0].id, gname: 'Guardian', email, phone: '' });
    const a = await add('Tara Rao', 'rao@mail.test');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const due = (await call(T.admin, 'GET', '/fees/pending')).body.find((r) => r.name === 'Tara Rao');
    assert.equal(due.balance, 25000);
    assert.equal((await add('Uma Rao', 'rao@mail.test')).status, 200);
    const full = await add('Vik Rao', 'rao2@mail.test');
    assert.equal(full.status, 409);
    assert.match(full.body.error, /full/);
    assert.equal((await call(T.van, 'POST', '/students', { name: 'X', cls: '', veh: bus3, stop: '', gname: 'G', email: 'g@mail.test', phone: '' })).status, 403);
  });
  it('the new driver sees them in route order; the other drivers do not', async () => {
    assert.equal((await call(T.anil, 'GET', '/students')).body.length, 2);
    assert.ok((await call(T.van, 'GET', '/students')).body.every((s) => s.veh === '1'));
  });
  it('moves a student to another bus and stop: fees follow him, the seat limit and stop ownership are enforced', async () => {
    const before = (await call(T.admin, 'GET', '/students')).body.find((s) => s.name === 'Diya Naik'); // vehicle 2
    assert.equal(before.veh, '2');
    const stops1 = (await call(T.admin, 'GET', '/vehicles/1/stops')).body;
    const stops2 = (await call(T.admin, 'GET', '/vehicles/2/stops')).body;
    const dueBefore = (await call(T.admin, 'GET', `/students/${before.id}/statement`)).body;
    // a stop of another vehicle is refused, and so is a full vehicle
    assert.equal((await call(T.admin, 'PUT', `/admin/students/${before.id}/placement`, { veh: '1', stop: stops2[0].id })).status, 400);
    assert.equal((await call(T.admin, 'PUT', `/admin/students/${before.id}/placement`, { veh: bus3, stop: '' })).status, 409);
    const ok = await call(T.admin, 'PUT', `/admin/students/${before.id}/placement`, { veh: '1', stop: stops1[1].id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = (await call(T.admin, 'GET', '/students')).body.find((s) => s.id === before.id);
    assert.equal(after.veh, '1');
    assert.equal(after.stop, stops1[1].name);
    assert.deepEqual((await call(T.admin, 'GET', `/students/${before.id}/statement`)).body, dueBefore); // history untouched
    assert.ok((await call(T.van, 'GET', '/students')).body.some((s) => s.id === before.id)); // now visible to the van driver
    assert.equal((await call(T.admin, 'PUT', '/admin/students/999/placement', { veh: '1', stop: '' })).status, 404);
  });
  it('can change just the stop on the same bus even when it is full', async () => {
    const stops = (await call(T.admin, 'GET', `/vehicles/${bus3}/stops`)).body;
    const tara = (await call(T.admin, 'GET', '/students')).body.find((s) => s.name === 'Tara Rao');
    assert.equal((await call(T.admin, 'PUT', `/admin/students/${tara.id}/placement`, { veh: bus3, stop: stops[2].id })).status, 200);
  });
});

describe('admin: stops', () => {
  it('adds at the end, reorders, renames and sets a time; refuses to delete a stop in use', async () => {
    const list = async () => (await call(T.admin, 'GET', `/vehicles/${bus3}/stops`)).body;
    const add = await call(T.admin, 'POST', `/admin/vehicles/${bus3}/stops`, { name: 'Mill Chowk', typical: '07:40' });
    assert.equal(add.status, 200);
    let s = await list();
    assert.deepEqual(s.map((x) => x.name), ['Temple Road', 'Lake View', 'School Gate', 'Mill Chowk']);
    assert.equal(s[3].typical, '07:40');
    await call(T.admin, 'POST', `/admin/stops/${s[3].id}/move`, { dir: 'up' });
    await call(T.admin, 'POST', `/admin/stops/${s[0].id}/move`, { dir: 'up' }); // already first: no-op
    await call(T.admin, 'POST', `/admin/stops/${s[0].id}/move`, { dir: 'down' });
    s = await list();
    assert.deepEqual(s.map((x) => x.name), ['Lake View', 'Temple Road', 'Mill Chowk', 'School Gate']);
    assert.deepEqual(s.map((x) => x.seq), [1, 2, 3, 4]);
    assert.equal((await call(T.admin, 'PUT', `/admin/stops/${s[2].id}`, { name: 'Mill Square', typical: '' })).status, 200);
    assert.equal((await call(T.admin, 'PUT', `/admin/stops/${s[2].id}`, { typical: '7pm' })).status, 400);
    assert.equal((await list())[2].name, 'Mill Square');
    const used = s.find((x) => x.name === 'School Gate'); // Tara sits here
    const refused = await call(T.admin, 'DELETE', `/admin/stops/${used.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /uses this stop/);
    assert.equal((await call(T.admin, 'DELETE', `/admin/stops/${s[2].id}`)).status, 200);
    assert.equal((await list()).length, 3);
  });
  it('the route order drives the driver screen: a reordered stop changes who is next', async () => {
    const stops = (await call(T.admin, 'GET', `/vehicles/${bus3}/stops`)).body;
    const first = async () => (await call(T.anil, 'GET', '/trip?direction=pickup')).body.roster[0].name;
    const before = await first();
    const sg = stops.find((x) => x.name === 'School Gate');
    await call(T.admin, 'POST', `/admin/stops/${sg.id}/move`, { dir: 'up' });
    await call(T.admin, 'POST', `/admin/stops/${sg.id}/move`, { dir: 'up' });
    assert.ok(before);
    assert.notEqual(await first(), before);
  });
});

describe('admin: fee, edit, driver, retire', () => {
  it('sets a bus fee for a later month without touching existing dues', async () => {
    assert.equal((await call(T.admin, 'POST', `/admin/vehicles/${bus3}/fee-plans`, { amount: 30000, from: '2026-11-01' })).status, 409);
    assert.equal((await call(T.admin, 'POST', `/admin/vehicles/${bus3}/fee-plans`, { amount: 30000, from: '2026-12-01' })).status, 200);
    assert.equal((await call(T.admin, 'POST', '/admin/vehicles/999/fee-plans', { amount: 30000, from: '2026-12-01' })).status, 404);
    assert.equal((await call(T.admin, 'GET', '/fees/pending')).body.find((r) => r.name === 'Tara Rao').balance, 25000);
    assert.equal((await overview()).vehicles.find((v) => v.id === bus3).fee, 25000); // December plan is not in force yet
    t.state.clock = new Date('2026-12-01T03:30:00Z'); // still inside the 30-day sign-in
    try {
      assert.equal((await overview()).vehicles.find((v) => v.id === bus3).fee, 30000);
    } finally {
      t.state.clock = MON;
    }
  });
  it('edits name, reg and seats; seats cannot drop below the students on board; reg stays unique', async () => {
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}`, { capacity: 1 })).status, 409);
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}`, { regNo: 'MH-20 AB 1234' })).status, 409); // vehicle 1
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}`, { name: 'Tempo', capacity: 3, regNo: 'mh-20 ef 9012' })).status, 200);
    const v = (await overview()).vehicles.find((x) => x.id === bus3);
    assert.equal([v.name, v.cap, v.reg].join('|'), 'Tempo|3|MH-20 EF 9012');
  });
  it('replaces the driver: the old one is signed out, the new one takes over', async () => {
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/driver`, { name: 'Ravi Pawar', email: 'ramesh@vandesk.test' })).status, 409); // drives vehicle 1
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/driver`, { name: 'Ravi Pawar', email: 'ravi@vandesk.test' })).status, 200);
    assert.equal((await call(T.anil, 'GET', '/me')).status, 401); // suspended
    T.ravi = await t.signIn('ravi@vandesk.test');
    assert.equal((await call(T.ravi, 'GET', '/me')).body.veh, bus3);
    assert.equal((await overview()).vehicles.find((v) => v.id === bus3).driver, 'Ravi Pawar');
    // handing the bus back to Anil re-activates his account
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/driver`, { name: 'Anil More', email: 'anil@vandesk.test' })).status, 200);
    assert.equal((await call(T.ravi, 'GET', '/me')).status, 401);
    T.anil = await t.signIn('anil@vandesk.test');
    assert.equal((await call(T.anil, 'GET', '/me')).body.veh, bus3);
  });
  it('retires only an empty bus, removes it from pickers, and can bring it back', async () => {
    const r = await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/in-service`, { inService: false });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Move the 2 students/);
    const kids = (await call(T.admin, 'GET', '/students')).body.filter((s) => s.veh === bus3);
    for (const k of kids) assert.equal((await call(T.admin, 'PUT', `/admin/students/${k.id}/placement`, { veh: '2', stop: '' })).status, 200);
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/in-service`, { inService: false })).status, 200);
    const v = (await overview()).vehicles.find((x) => x.id === bus3);
    assert.equal(v.inService, false);
    assert.equal(v.driver, '');
    assert.equal((await overview()).vehicles.at(-1).id, bus3); // retired buses sort last
    assert.equal((await call(T.admin, 'GET', '/vehicles')).body.some((x) => x.id === bus3), false);
    assert.equal((await call(T.anil, 'GET', '/me')).status, 401); // no bus, no access
    const blocked = await call(T.admin, 'POST', '/students', { name: 'New', cls: '', veh: bus3, stop: '', gname: 'G', email: 'g9@mail.test', phone: '' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /not in service/);
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/driver`, { name: 'Anil More', email: 'anil@vandesk.test' })).status, 409); // restore first
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/in-service`, { inService: true })).status, 200);
    assert.equal((await call(T.admin, 'PUT', `/admin/vehicles/${bus3}/driver`, { name: 'Anil More', email: 'anil@vandesk.test' })).status, 200);
  });
  it('writes an audit trail for every change', async () => {
    const n = (await t.db.query("select count(*)::int as n from audit_logs where action like 'vehicle.%' or action like 'stop.%' or action like 'student.move'")).rows[0].n;
    assert.ok(n >= 12, `audit rows: ${n}`);
  });
});
