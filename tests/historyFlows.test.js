const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const CarTrip = require('../models/Cars');
const Expense = require('../models/Expense');
const cars = require('../routes/cars');
const expenses = require('../routes/expenses');

function handler(router, path, method) {
  return router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const id = '507f1f77bcf86cd799439011';
function request(body, role = 'superadmin') {
  return { params: { id }, branchId: 'beni', body, user: { id, role, name: 'Reviewer', canValidate: true } };
}
function trip() {
  return { _id: id, status: 'arrived', inventoryProcessed: true, actualArrivalTime: new Date('2026-09-20T10:00:00Z'), departureTime: new Date('2026-09-19T10:00:00Z'), editHistory: [], async save() {} };
}

test('superadmin corrects confirmed dates with audit history and without stock writes', async (t) => {
  const record = trip();
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }));
  t.mock.method(CarTrip, 'findOne', filter => {
    assert.equal(filter.$and[1].branchId, 'beni');
    return { session: async () => record };
  });
  const res = response();
  await handler(cars, '/:id', 'put')(request({ actualArrivalTime: '2026-09-21T12:00:00+02:00', departureTime: '2026-09-18T10:00:00Z', reason: 'Correct receipt date' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(record.actualArrivalTime.toISOString(), '2026-09-21T10:00:00.000Z');
  assert.equal(record.departureTime.toISOString(), '2026-09-18T10:00:00.000Z');
  assert.equal(record.status, 'arrived');
  assert.equal(record.inventoryProcessed, true);
  assert.ok(record.editHistory[0].changes.actualArrivalTime);
});

test('confirmed trip edits reject unauthorized users, invalid dates and missing reasons', async (t) => {
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }));
  t.mock.method(CarTrip, 'findOne', () => ({ session: async () => trip() }));
  for (const [role, body, status] of [
    ['manager', { reason: 'Correction' }, 403],
    ['superadmin', { actualArrivalTime: 'invalid', reason: 'Correction' }, 400],
    ['superadmin', { actualArrivalTime: '2026-09-21' }, 400],
  ]) {
    const res = response();
    await handler(cars, '/:id', 'put')(request(body, role), res);
    assert.equal(res.statusCode, status);
  }
});

test('completing a trip preserves its confirmed arrival date', async (t) => {
  const record = trip();
  const originalDate = record.actualArrivalTime.toISOString();
  t.mock.method(CarTrip, 'findOne', async () => record);
  const res = response();
  await handler(cars, '/:id/status', 'patch')(request({ status: 'completed' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(record.actualArrivalTime.toISOString(), originalDate);
});

test('expense validation and rejection atomically require pending status', async (t) => {
  t.mock.method(Expense, 'findOne', async () => ({ _id: id, status: 'pending', notes: '' }));
  let state = 'pending';
  t.mock.method(Expense, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.$and[0].status, 'pending');
    assert.equal(filter.$and[1].branchId, 'beni');
    if (state !== 'pending') return null;
    state = update.status;
    return { _id: id, ...update };
  });
  t.mock.method(Expense, 'findOneAndDelete', async (filter) => {
    assert.equal(filter.$and[0].status, 'pending');
    assert.equal(filter.$and[1].branchId, 'beni');
    if (state !== 'pending') return null;
    state = 'deleted';
    return { _id: id };
  });
  const validated = response();
  await handler(expenses, '/:id/validate', 'patch')(request({}), validated);
  assert.equal(validated.statusCode, 200);
  assert.equal(validated.body.status, 'validated');
  const conflict = response();
  await handler(expenses, '/:id/reject', 'patch')(request({ reason: 'Duplicate' }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(state, 'validated');
  state = 'pending';
  const rejected = response();
  await handler(expenses, '/:id/reject', 'patch')(request({ reason: 'Duplicate' }), rejected);
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.body.deletedExpenseId, id);
  assert.equal(state, 'deleted');
});

test('repeated arrival confirmation returns a conflict before changing inventory', async (t) => {
  const record = trip();
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }));
  t.mock.method(CarTrip, 'findOne', () => ({ session: async () => record }));
  const res = response();
  await handler(cars, '/:id/confirm-arrival', 'patch')(request({}), res);
  assert.equal(res.statusCode, 409);
  assert.equal(record.editHistory.length, 0);
});
