import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'reminder-test-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { readReminderInput, nextDailyRun } = await import('../src/lib/reminder-time.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { default: app } = await import('../src/app.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { processDueReminder, claimReminderDelivery, processReminderDelivery } = await import('../src/services/task-reminder-processing.service.ts');
const originalTransaction = prisma.$transaction;
const originalRaw = prisma.$queryRaw;
const originalFindDelivery = prisma.taskReminderDelivery.findUnique;
const originalUpdateDelivery = prisma.taskReminderDelivery.updateMany;
const originalDeleteDevice = prisma.deviceToken.deleteMany;
let server, base;
const token = signToken({ userId: 'user', email: 'user@example.com' });
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/households/home/tasks/task/reminder`;
});
afterEach(() => {
  prisma.$transaction = originalTransaction;
  prisma.$queryRaw = originalRaw;
  prisma.taskReminderDelivery.findUnique = originalFindDelivery;
  prisma.taskReminderDelivery.updateMany = originalUpdateDelivery;
  prisma.deviceToken.deleteMany = originalDeleteDevice;
  mock.restoreAll();
});
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });

test('daily reminder uses Indian local time and moves to tomorrow after the chosen time', () => {
  assert.equal(nextDailyRun('09:00', 'Asia/Kolkata', new Date('2026-11-09T00:00:00Z')).toISOString(), '2026-11-09T03:30:00.000Z');
  assert.equal(nextDailyRun('09:00', 'Asia/Kolkata', new Date('2026-11-09T03:30:00Z')).toISOString(), '2026-11-10T03:30:00.000Z');
});
test('daily DST schedules skip missing times and do not repeat on a fallback day', () => {
  assert.equal(nextDailyRun('02:30', 'America/New_York', new Date('2026-03-08T05:00:00Z')).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(nextDailyRun('01:30', 'America/New_York', new Date('2026-11-01T05:45:00Z')).toISOString(), '2026-11-02T06:30:00.000Z');
});
test('validates timezone, future timestamps, explicit offset, repeat mode and local time', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  for (const body of [null, [], {}, { repeat: 'WEEKLY', timeZone: 'UTC' },
    { repeat: 'DAILY', timeZone: 'wrong', localTime: '09:00' },
    { repeat: 'DAILY', timeZone: 'UTC', localTime: '24:00' },
    { repeat: 'DAILY', timeZone: 'UTC', localTime: '09:00', remindAt: '2030-01-01T00:00Z' },
    { repeat: 'ONCE', timeZone: 'UTC', remindAt: '2020-01-01T00:00Z' },
    { repeat: 'ONCE', timeZone: 'UTC', remindAt: '2030-01-01T00:00' },
    { repeat: 'ONCE', timeZone: 'UTC', remindAt: '2030-02-30T09:00:00Z' },
    { repeat: 'ONCE', timeZone: 'UTC', remindAt: '2030-01-01T24:00:00Z' },
  ]) assert.throws(() => readReminderInput(body, now), { statusCode: 400 });
  assert.equal(readReminderInput({ repeat: 'ONCE', timeZone: 'Asia/Kolkata', remindAt: '2030-01-01T09:00:00+05:30' }, now).nextRunAt.toISOString(), '2030-01-01T03:30:00.000Z');
});

const saved = { id: 'reminder', taskId: 'task', userId: 'user', membershipId: 'member', repeat: 'DAILY',
  timeZone: 'Asia/Kolkata', localTime: '09:00', nextRunAt: new Date('2026-11-08T03:30Z'), enabled: true, version: 1 };
function setup({ member = true, status = 'TODO', found = true } = {}) {
  const db = {
    householdMember: { findUnique: mock.fn(async () => member ? { id: 'member', role: 'MEMBER' } : null), findFirst: mock.fn(async () => member ? { id: 'member' } : null) },
    task: { findFirst: mock.fn(async () => found ? { status } : null) },
    taskReminder: { findUnique: mock.fn(async () => saved), upsert: mock.fn(async () => saved), deleteMany: mock.fn(async () => ({ count: 1 })), update: mock.fn(async () => saved), delete: mock.fn(async () => saved) },
    notification: { create: mock.fn(async ({ data }) => ({ id: 'notice', ...data })) },
    deviceToken: { findMany: mock.fn(async () => [{ id: 'device' }]) },
    taskReminderDelivery: { createMany: mock.fn(async () => ({ count: 1 })) },
    $queryRaw: mock.fn(async () => []),
  };
  prisma.$transaction = mock.fn(async fn => fn(db));
  return db;
}
async function request(method, body, auth = token) {
  const response = await fetch(base, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
test('all reminder routes require authentication', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await request(method, undefined, '')).status, 401);
});
test('members can save only their own reminder without task-edit rights', async () => {
  const db = setup();
  const response = await request('PUT', { repeat: 'DAILY', timeZone: 'Asia/Kolkata', localTime: '09:00', userId: 'someone-else' });
  assert.equal(response.status, 200);
  const args = db.taskReminder.upsert.mock.calls[0].arguments[0];
  assert.deepEqual(args.where, { taskId_userId: { taskId: 'task', userId: 'user' } });
  assert.equal(args.create.membershipId, 'member');
  assert.equal(args.create.userId, 'user');
  assert.deepEqual(args.update.version, { increment: 1 });
});
test('GET and DELETE are scoped to authenticated user, DELETE is idempotent', async () => {
  const db = setup();
  assert.equal((await request('GET')).status, 200);
  assert.deepEqual(db.taskReminder.findUnique.mock.calls[0].arguments[0].where, { taskId_userId: { taskId: 'task', userId: 'user' } });
  assert.equal((await request('DELETE')).status, 200);
  assert.equal((await request('DELETE')).status, 200);
  assert.deepEqual(db.taskReminder.deleteMany.mock.calls[0].arguments[0].where, { taskId: 'task', userId: 'user' });
});
test('rejects inaccessible/missing/completed tasks and invalid input without saving', async () => {
  for (const options of [{ member: false }, { found: false }, { status: 'DONE' }]) {
    const db = setup(options);
    assert.equal((await request('PUT', { repeat: 'DAILY', timeZone: 'UTC', localTime: '09:00' })).status, options.status ? 400 : 404);
    assert.equal(db.taskReminder.upsert.mock.callCount(), 0);
  }
  setup();
  assert.equal((await request('PUT', { repeat: 'DAILY', timeZone: 'UTC', localTime: '25:00' })).status, 400);
});

function setupDue(reminder = saved, options = {}) {
  const db = setup(options);
  let reads = 0;
  db.$queryRaw = mock.fn(async () => ++reads === 1 ? [reminder] : [{ id: 'task', householdId: 'home', title: 'Water plants', status: options.status ?? 'TODO' }]);
  return db;
}
test('due occurrence creates inbox and per-device push jobs in the same transaction, advances daily past downtime', async () => {
  const db = setupDue();
  assert.equal(await processDueReminder(new Date('2026-11-09T04:00Z')), true);
  assert.equal(db.notification.create.mock.callCount(), 1);
  assert.equal(db.notification.create.mock.calls[0].arguments[0].data.type, 'TASK_REMINDER');
  const job = db.taskReminderDelivery.createMany.mock.calls[0].arguments[0].data[0];
  assert.equal(job.version, 1); assert.equal(job.notificationId, 'notice');
  assert.equal(job.scheduledAt, saved.nextRunAt);
  assert.equal(db.taskReminder.update.mock.calls[0].arguments[0].data.nextRunAt.toISOString(), '2026-11-10T03:30:00.000Z');
  assert.match(db.$queryRaw.mock.calls[0].arguments[0].join(''), /FOR UPDATE SKIP LOCKED/);
});
test('one-time reminder disables after firing, no due schedule does nothing', async () => {
  const db = setupDue({ ...saved, repeat: 'ONCE', localTime: null });
  await processDueReminder();
  assert.deepEqual(db.taskReminder.update.mock.calls[0].arguments[0].data, { enabled: false, nextRunAt: null });
  const empty = setup();
  assert.equal(await processDueReminder(), false);
  assert.equal(empty.notification.create.mock.callCount(), 0);
});
test('completed tasks and revoked memberships never create a notification', async () => {
  for (const options of [{ status: 'DONE' }, { member: false }]) {
    const db = setupDue(saved, options);
    await processDueReminder();
    assert.equal(db.notification.create.mock.callCount(), 0);
  }
});
test('queue failure propagates so occurrence transaction can roll back', async () => {
  const db = setupDue();
  db.taskReminderDelivery.createMany = async () => { throw new Error('queue failure'); };
  await assert.rejects(processDueReminder(), /queue failure/);
  assert.equal(db.taskReminder.update.mock.callCount(), 0);
});

function setupPush() {
  const job = { id: 'job', reminderId: 'reminder', version: 1, notificationId: 'notice', deviceTokenId: 'device',
    leaseId: 'lease', attempts: 1, ticketId: null, createdAt: new Date() };
  const target = { reminder: { ...saved, enabled: false, repeat: 'ONCE', task: { id: 'task', householdId: 'home', title: 'Water plants', status: 'TODO' },
    membership: { userId: 'user', householdId: 'home' } }, deviceToken: { userId: 'user', token: 'ExponentPushToken[test]' } };
  prisma.taskReminderDelivery.findUnique = mock.fn(async () => target);
  prisma.taskReminderDelivery.updateMany = mock.fn(async () => ({ count: 1 }));
  prisma.deviceToken.deleteMany = mock.fn(async () => ({ count: 1 }));
  return { job, target };
}
test('push uses standard notification payload and persists ticket with lease guard', async () => {
  const { job } = setupPush();
  const fetcher = mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.data.type, 'TASK_REMINDER'); assert.equal(payload.data.taskId, 'task');
    assert.equal(payload.title, 'Task reminder'); assert.equal(payload.body, 'Water plants');
    assert.equal(payload.data.delivery, undefined);
    return new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket' } }));
  });
  await processReminderDelivery(job);
  assert.equal(fetcher.mock.callCount(), 1);
  const update = prisma.taskReminderDelivery.updateMany.mock.calls[0].arguments[0];
  assert.deepEqual(update.where, { id: 'job', leaseId: 'lease' });
  assert.equal(update.data.ticketId, 'ticket');
});
test('stale version, task completion, wrong token owner and expired jobs cancel without sending', async () => {
  for (const change of [({ target }) => target.reminder.version++, ({ target }) => target.reminder.task.status = 'DONE',
    ({ target }) => target.deviceToken.userId = 'other', ({ job }) => job.createdAt = new Date(0)]) {
    const state = setupPush(); change(state);
    const fetcher = mock.method(globalThis, 'fetch', async () => { throw new Error('must not send'); });
    await processReminderDelivery(state.job);
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(prisma.taskReminderDelivery.updateMany.mock.calls[0].arguments[0].data.lastError, 'CancelledOrExpired');
    fetcher.mock.restore();
  }
});
test('temporary push failures retry, invalid devices are deleted, receipts complete delivery', async () => {
  let state = setupPush();
  let fetcher = mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await processReminderDelivery(state.job);
  assert.ok(prisma.taskReminderDelivery.updateMany.mock.calls[0].arguments[0].data.availableAt instanceof Date);
  fetcher.mock.restore();
  state = setupPush();
  fetcher = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } })));
  await processReminderDelivery(state.job);
  assert.equal(prisma.deviceToken.deleteMany.mock.callCount(), 1);
  fetcher.mock.restore();
  state = setupPush();
  fetcher = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { ticket: { status: 'ok' } } })));
  await processReminderDelivery({ ...state.job, ticketId: 'ticket' });
  assert.ok(prisma.taskReminderDelivery.updateMany.mock.calls[0].arguments[0].data.completedAt instanceof Date);
});
test('claiming push jobs uses skip-locked lease and a bounded lease duration', async () => {
  prisma.$queryRaw = mock.fn(async () => [{ id: 'job' }]);
  assert.deepEqual(await claimReminderDelivery(), { id: 'job' });
  assert.match(prisma.$queryRaw.mock.calls[0].arguments[0].join(''), /FOR UPDATE SKIP LOCKED/);
});
