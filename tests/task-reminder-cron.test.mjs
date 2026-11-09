import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'reminder-cron-test-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: prisma } = await import('../src/lib/prisma.ts');
const { default: app } = await import('../src/app.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { processTaskReminderBatch } = await import('../src/services/task-reminder-processing.service.ts');
const savedEnv = { secret: process.env.TASK_REMINDER_CRON_SECRET, push: process.env.EXPO_PUSH_ENABLED };
const secret = 'test-cron-secret-that-is-at-least-32-characters';
const originals = {
  transaction: prisma.$transaction, raw: prisma.$queryRaw,
  cleanup: prisma.taskReminderDelivery.deleteMany, find: prisma.taskReminderDelivery.findUnique,
  update: prisma.taskReminderDelivery.updateMany,
};
let server, url;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}/api/internal/task-reminders/run`;
});
afterEach(() => {
  prisma.$transaction = originals.transaction;
  prisma.$queryRaw = originals.raw;
  prisma.taskReminderDelivery.deleteMany = originals.cleanup;
  prisma.taskReminderDelivery.findUnique = originals.find;
  prisma.taskReminderDelivery.updateMany = originals.update;
  for (const [name, value] of [['TASK_REMINDER_CRON_SECRET', savedEnv.secret], ['EXPO_PUSH_ENABLED', savedEnv.push]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  mock.restoreAll();
});
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });

function setup() {
  process.env.TASK_REMINDER_CRON_SECRET = secret;
  process.env.EXPO_PUSH_ENABLED = 'true';
  prisma.$transaction = mock.fn(async () => false);
  prisma.$queryRaw = mock.fn(async () => []);
  prisma.taskReminderDelivery.deleteMany = mock.fn(async () => ({ count: 0 }));
  prisma.taskReminderDelivery.findUnique = mock.fn(async () => null);
  prisma.taskReminderDelivery.updateMany = mock.fn(async () => ({ count: 1 }));
}
async function request(auth = `Bearer ${secret}`, method = 'POST') {
  const response = await fetch(url, { method, headers: auth ? { Authorization: auth } : {} });
  const content = await response.text();
  return { status: response.status, cache: response.headers.get('cache-control'),
    body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content };
}

test('cron endpoint fails closed if the secret is missing, too short, or contains whitespace', async () => {
  setup();
  for (const value of [undefined, '', 'short', secret + '\n']) {
    if (value === undefined) delete process.env.TASK_REMINDER_CRON_SECRET;
    else process.env.TASK_REMINDER_CRON_SECRET = value;
    const response = await request();
    assert.equal(response.status, 503);
    assert.equal(response.cache, 'no-store');
  }
  assert.equal(prisma.$transaction.mock.callCount(), 0);
  assert.equal(prisma.$queryRaw.mock.callCount(), 0);
});
test('missing, incorrect, malformed and ordinary user JWT credentials cannot trigger jobs', async () => {
  setup();
  const jwt = signToken({ userId: 'user', email: 'user@example.com' });
  for (const auth of ['', 'Bearer wrong', `Basic ${secret}`, `Bearer ${secret} extra`, `Bearer ${jwt}`]) {
    const response = await request(auth);
    assert.equal(response.status, 401);
    assert.equal(JSON.stringify(response.body).includes(secret), false);
  }
  assert.equal(prisma.$transaction.mock.callCount(), 0);
  assert.equal(prisma.taskReminderDelivery.deleteMany.mock.callCount(), 0);
});
test('GET cannot trigger a job; valid secret processes schedules, queue and retention', async () => {
  setup();
  assert.equal((await request(undefined, 'GET')).status, 404);
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    message: 'Task reminder batch processed', remindersProcessed: 0, deliveriesProcessed: 0,
    pushEnabled: true, batchLimitReached: false,
  });
  assert.equal(prisma.$transaction.mock.callCount(), 1);
  assert.equal(prisma.$queryRaw.mock.callCount(), 1);
  assert.equal(prisma.taskReminderDelivery.deleteMany.mock.callCount(), 1);
});
test('push disabled still processes schedules but never claims deliveries', async () => {
  setup(); process.env.EXPO_PUSH_ENABLED = 'false';
  let calls = 0;
  prisma.$transaction = mock.fn(async () => ++calls === 1);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.remindersProcessed, 1);
  assert.equal(response.body.pushEnabled, false);
  assert.equal(prisma.$queryRaw.mock.callCount(), 0);
});
test('bounded batch alternates schedules and deliveries and leaves backlog for the next call', async () => {
  setup();
  const order = [];
  prisma.$transaction = mock.fn(async () => { order.push('schedule'); return true; });
  prisma.$queryRaw = mock.fn(async () => {
    order.push('delivery');
    return [{ id: 'job', leaseId: 'lease', attempts: 1, createdAt: new Date() }];
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.remindersProcessed, 100);
  assert.equal(response.body.deliveriesProcessed, 50);
  assert.equal(response.body.batchLimitReached, true);
  assert.deepEqual(order.slice(0, 4), ['schedule', 'delivery', 'schedule', 'delivery']);
  assert.equal(prisma.taskReminderDelivery.updateMany.mock.callCount(), 50);
});
test('queued deliveries are processed even when no reminder is newly due', async () => {
  setup();
  let claims = 0;
  prisma.$queryRaw = mock.fn(async () => ++claims === 1
    ? [{ id: 'job', leaseId: 'lease', attempts: 1, createdAt: new Date() }] : []);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.remindersProcessed, 0);
  assert.equal(response.body.deliveriesProcessed, 1);
});
test('a later reminder can enqueue a push after an earlier empty queue check', async () => {
  setup();
  let schedules = 0, claims = 0;
  prisma.$transaction = mock.fn(async () => ++schedules <= 2);
  prisma.$queryRaw = mock.fn(async () => ++claims === 2
    ? [{ id: 'job', leaseId: 'lease', attempts: 1, createdAt: new Date() }] : []);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.remindersProcessed, 2);
  assert.equal(response.body.deliveriesProcessed, 1);
});
test('processing budget stops further work and reports a possible backlog', async () => {
  setup();
  let clock = 0;
  mock.method(Date, 'now', () => { const current = clock; clock += 10_000; return current; });
  prisma.$transaction = mock.fn(async () => true);
  const result = await processTaskReminderBatch();
  assert.equal(result.remindersProcessed, 1);
  assert.equal(result.deliveriesProcessed, 0);
  assert.equal(result.batchLimitReached, true);
});
test('database errors return 500 without exposing internals; a later cron call can retry', async () => {
  setup();
  const log = mock.method(console, 'error', () => {});
  prisma.$transaction = mock.fn(async () => { throw new Error('private database connection details'); });
  const response = await request();
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response.body).includes('private database'), false);
  assert.equal(log.mock.callCount(), 1);
  prisma.$transaction = mock.fn(async () => false);
  assert.equal((await request()).status, 200);
});
