import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'notification-api-tests';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const token = signToken({ userId: 'alice', email: 'alice@example.com' });
const methods = ['findMany', 'count', 'updateMany', 'deleteMany'];
const originals = Object.fromEntries(methods.map(name => [name, prisma.notification[name]]));
const originalTransaction = prisma.$transaction;
let server, base, rows;
const endpoints = [['GET', ''], ['GET', '/unread-count'], ['PATCH', '/own/read'], ['PATCH', '/read-all'], ['DELETE', '/own']];

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/notifications`;
});
beforeEach(() => {
  rows = [
    { id: 'own', userId: 'alice', isRead: false, createdAt: '2026-09-19T10:00:00Z' },
    { id: 'read', userId: 'alice', isRead: true, createdAt: '2026-09-19T09:00:00Z' },
    { id: 'foreign', userId: 'bob', isRead: false, createdAt: '2026-09-19T11:00:00Z' },
  ];
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  prisma.notification.findMany = mock.fn(async ({ where, skip, take, orderBy }) => {
    assert.equal(where.userId, 'alice');
    assert.deepEqual(orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    return rows.filter(row => matches(row, where)).slice(skip, skip + take);
  });
  prisma.notification.count = mock.fn(async ({ where }) => {
    assert.equal(where.userId, 'alice');
    return rows.filter(row => matches(row, where)).length;
  });
  prisma.notification.updateMany = mock.fn(async ({ where, data }) => {
    assert.equal(where.userId, 'alice');
    const matching = rows.filter(row => matches(row, where));
    matching.forEach(row => Object.assign(row, data));
    return { count: matching.length };
  });
  prisma.notification.deleteMany = mock.fn(async ({ where }) => {
    assert.equal(where.userId, 'alice');
    const count = rows.filter(row => matches(row, where)).length;
    rows = rows.filter(row => !matches(row, where));
    return { count };
  });
  prisma.$transaction = mock.fn(async (operation, options) => {
    assert.equal(options.isolationLevel, 'RepeatableRead');
    return operation({ notification: prisma.notification });
  });
});
afterEach(() => {
  for (const name of methods) prisma.notification[name] = originals[name];
  prisma.$transaction = originalTransaction;
  mock.restoreAll();
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
});
async function request(method, path, auth = `Bearer ${token}`, body) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
for (const [method, path] of endpoints) {
  test(`${method} ${path || '/'} requires a valid token before querying`, async () => {
    for (const auth of [null, 'Bearer invalid']) {
      assert.equal((await request(method, path, auth)).status, 401);
    }
    for (const name of methods) assert.equal(prisma.notification[name].mock.callCount(), 0);
    assert.equal(prisma.$transaction.mock.callCount(), 0);
  });
  test(`${method} ${path || '/'} hides unexpected database errors`, async () => {
    for (const name of methods) prisma.notification[name] = async () => { throw new Error('Private database details'); };
    mock.method(console, 'error', () => {});
    assert.deepEqual(await request(method, path), { status: 500, body: { message: 'Notification operation failed' } });
  });
}
test('list returns only own notifications, with defaults and pagination', async () => {
  const result = await request('GET', '?userId=bob');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.notifications.map(row => row.id), ['own', 'read']);
  assert.deepEqual(result.body.pagination, { page: 1, limit: 20, total: 2, totalPages: 1 });
  const second = await request('GET', '?page=2&limit=1');
  assert.deepEqual(second.body.notifications.map(row => row.id), ['read']);
  assert.deepEqual(second.body.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
});
test('unread=true selects unread, unread=false selects read; empty inbox is supported', async () => {
  assert.deepEqual((await request('GET', '?unread=true')).body.notifications.map(row => row.id), ['own']);
  assert.deepEqual((await request('GET', '?unread=false')).body.notifications.map(row => row.id), ['read']);
  rows = [];
  const result = await request('GET', '');
  assert.deepEqual(result.body.notifications, []);
  assert.equal(result.body.pagination.totalPages, 0);
});
test('invalid or repeated query parameters fail before querying', async () => {
  for (const query of ['page=0', 'page=1.5', 'page=100001', 'page=1&page=2', 'limit=0', 'limit=101', 'limit=abc', 'unread=1', 'unread=', 'unread=true&unread=false']) {
    assert.equal((await request('GET', '?' + query)).status, 400, query);
  }
  assert.equal(prisma.$transaction.mock.callCount(), 0);
});
test('unread count changes after marking read, and repeated marking succeeds', async () => {
  assert.deepEqual((await request('GET', '/unread-count')).body, { unreadCount: 1 });
  assert.equal((await request('PATCH', '/own/read')).status, 200);
  assert.equal((await request('PATCH', '/own/read')).status, 200);
  assert.deepEqual((await request('GET', '/unread-count')).body, { unreadCount: 0 });
});
test('read and delete cannot touch another user notification or expose its existence', async () => {
  for (const id of ['foreign', 'missing']) {
    assert.deepEqual(await request('PATCH', `/${id}/read`), { status: 404, body: { message: 'Notification not found' } });
    assert.deepEqual(await request('DELETE', `/${id}`), { status: 404, body: { message: 'Notification not found' } });
  }
  assert.equal(rows.find(row => row.id === 'foreign').isRead, false);
});
test('read-all ignores userId in the body and changes only own unread rows', async () => {
  const result = await request('PATCH', '/read-all', `Bearer ${token}`, { userId: 'bob' });
  assert.equal(result.status, 200);
  assert.equal(result.body.updatedCount, 1);
  assert.equal(rows.find(row => row.id === 'foreign').isRead, false);
  assert.equal((await request('PATCH', '/read-all')).body.updatedCount, 0);
});
test('delete removes only the owned notification and updates the count', async () => {
  assert.equal((await request('DELETE', '/own')).status, 200);
  assert.deepEqual((await request('GET', '/unread-count')).body, { unreadCount: 0 });
  assert.equal((await request('DELETE', '/own')).status, 404);
  assert.ok(rows.some(row => row.id === 'foreign'));
});
