import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'member-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { Prisma } = await import('../generated/prisma/client.ts');
const originalTransaction = prisma.$transaction;
let server, base, db;
const token = signToken({ userId: 'actor', email: 'actor@example.com' });
const member = { id: 'membership', role: 'MEMBER', user: { id: 'target', name: 'Target', email: 'target@example.com' } };
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/households`;
});
afterEach(() => { prisma.$transaction = originalTransaction; mock.restoreAll(); });
after(async () => {
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await prisma.$disconnect();
});
function setup(actor = 'OWNER', target = 'MEMBER', existing = true) {
  db = {
    householdMember: {
      findUnique: mock.fn(async ({ where }) => {
        const key = where.userId_householdId;
        assert.equal(key.householdId, 'home');
        return key.userId === 'actor' ? (actor ? { id: 'actor-membership', role: actor } : null) : (existing ? { id: 'membership', role: target } : null);
      }),
      findMany: mock.fn(async ({ where, select }) => {
        assert.deepEqual(where, { householdId: 'home' });
        assert.deepEqual(select, { id: true, role: true, user: { select: { id: true, name: true, email: true } } });
        return [member];
      }),
      create: mock.fn(async () => member),
      update: mock.fn(async () => member),
      delete: mock.fn(async () => member),
    },
    user: { findUnique: mock.fn(async () => ({ id: 'target' })) },
  };
  const transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  prisma.$transaction = transaction;
  return transaction;
}
async function request(method, body, auth = `Bearer ${token}`, target = 'target') {
  const path = `${base}/home/members${['PATCH', 'DELETE'].includes(method) ? '/' + target : ''}`;
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
  test(`${method} requires authentication`, async () => {
    const tx = setup();
    assert.equal((await request(method, undefined, null)).status, 401);
    assert.equal(tx.mock.callCount(), 0);
  });
  test(`${method} denies nonmembers before fetching target details`, async () => {
    setup(null);
    assert.equal((await request(method, { userId: 'target', role: 'MEMBER' })).status, 404);
    assert.equal(db.user.findUnique.mock.callCount(), 0);
    assert.equal(db.householdMember.findMany.mock.callCount(), 0);
    assert.equal(db.householdMember.create.mock.callCount(), 0);
    assert.equal(db.householdMember.update.mock.callCount(), 0);
    assert.equal(db.householdMember.delete.mock.callCount(), 0);
  });
}
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  test(`${actor} can list members with safe response fields`, async () => {
    setup(actor);
    assert.deepEqual(await request('GET'), { status: 200, body: { message: 'Household members fetched successfully', members: [member] } });
  });
  for (const role of ['ADMIN', 'MEMBER']) {
    test(`${actor} adding ${role} follows permissions`, async () => {
      setup(actor, 'MEMBER', false);
      const allowed = actor === 'OWNER' || (actor === 'ADMIN' && role === 'MEMBER');
      assert.equal((await request('POST', { userId: 'target', role })).status, allowed ? 201 : 403);
      assert.equal(db.householdMember.create.mock.callCount(), allowed ? 1 : 0);
    });
  }
  for (const target of ['OWNER', 'ADMIN', 'MEMBER']) {
    for (const role of ['ADMIN', 'MEMBER']) {
      test(`${actor} changing ${target} to ${role} follows permissions`, async () => {
        setup(actor, target);
        const allowed = target !== 'OWNER' && (actor === 'OWNER' || (actor === 'ADMIN' && target === 'MEMBER' && role === 'MEMBER'));
        assert.equal((await request('PATCH', { role })).status, allowed ? 200 : 403);
        assert.equal(db.householdMember.update.mock.callCount(), allowed ? 1 : 0);
      });
    }
    test(`${actor} removing ${target} follows permissions`, async () => {
      setup(actor, target);
      const allowed = target !== 'OWNER' && (actor === 'OWNER' || (actor === 'ADMIN' && target === 'MEMBER'));
      assert.equal((await request('DELETE')).status, allowed ? 200 : 403);
      assert.equal(db.householdMember.delete.mock.callCount(), allowed ? 1 : 0);
    });
  }
}
test('validates bodies before accessing the database', async () => {
  const tx = setup();
  for (const body of [undefined, {}, { userId: '' }, { userId: 1 }, { userId: 'target', role: 'OWNER' }, { userId: 'target', role: null }, { email: '' }, { email: 42 }, { email: 'target@example.com', role: 'OWNER' }, { userId: 'target', email: 'target@example.com' }]) {
    assert.equal((await request('POST', body)).status, 400);
  }
  for (const body of [undefined, {}, { role: 'OWNER' }, { role: 'member' }, { role: [] }]) {
    assert.equal((await request('PATCH', body)).status, 400);
  }
  assert.equal(tx.mock.callCount(), 0);
});
test('add defaults to MEMBER and ignores extra properties', async () => {
  setup('ADMIN', 'MEMBER', false);
  assert.equal((await request('POST', { userId: 'target', householdId: 'other', requesterId: 'owner' })).status, 201);
  assert.deepEqual(db.householdMember.create.mock.calls[0].arguments[0].data, { householdId: 'home', userId: 'target', role: 'MEMBER' });
});
test('add explains a missing or doubled target', async () => {
  const tx = setup();
  assert.deepEqual((await request('POST', {})).body, { message: 'User ID or email address is required' });
  assert.deepEqual((await request('POST', { email: '   ' })).body, { message: 'Email address is required' });
  assert.deepEqual((await request('POST', { userId: 'target', email: 'target@example.com' })).body, { message: 'Provide either a user ID or an email address, not both' });
  assert.equal(tx.mock.callCount(), 0);
});
test('add resolves a trimmed email to the registered user before creating membership', async () => {
  setup('OWNER', 'MEMBER', false);
  db.user.findUnique = mock.fn(async ({ where, select }) => {
    assert.deepEqual(where, { email: 'target@example.com' });
    assert.deepEqual(select, { id: true });
    return { id: 'target' };
  });
  assert.deepEqual(await request('POST', { email: ' target@example.com ', role: 'ADMIN' }), { status: 201, body: { message: 'Household member added successfully', member } });
  assert.equal(db.user.findUnique.mock.callCount(), 1);
  assert.deepEqual(db.householdMember.create.mock.calls[0].arguments[0].data, { householdId: 'home', userId: 'target', role: 'ADMIN' });
});
test('add by email checks permissions before looking the user up', async () => {
  setup('ADMIN', 'MEMBER', false);
  assert.equal((await request('POST', { email: 'target@example.com', role: 'ADMIN' })).status, 403);
  assert.equal(db.user.findUnique.mock.callCount(), 0);
  assert.equal(db.householdMember.create.mock.callCount(), 0);
});
test('add by email returns 404 for unregistered emails and 409 for existing members', async () => {
  setup();
  assert.equal((await request('POST', { email: 'target@example.com' })).status, 409);
  db.user.findUnique = mock.fn(async () => null);
  assert.equal((await request('POST', { email: 'unknown@example.com' })).status, 404);
  assert.equal(db.householdMember.create.mock.callCount(), 0);
});
test('missing user returns 404 and existing membership returns 409', async () => {
  setup();
  assert.equal((await request('POST', { userId: 'target' })).status, 409);
  db.user.findUnique = mock.fn(async () => null);
  assert.equal((await request('POST', { userId: 'target' })).status, 404);
  assert.equal(db.householdMember.create.mock.callCount(), 0);
});
test('missing update/delete target returns 404', async () => {
  setup('OWNER', 'MEMBER', false);
  assert.equal((await request('PATCH', { role: 'ADMIN' })).status, 404);
  assert.equal((await request('DELETE')).status, 404);
});
test('self-removal is denied for every role', async () => {
  for (const role of ['OWNER', 'ADMIN', 'MEMBER']) {
    setup(role);
    assert.equal((await request('DELETE', undefined, `Bearer ${token}`, 'actor')).status, 403);
    assert.equal(db.householdMember.delete.mock.callCount(), 0);
    mock.restoreAll();
  }
});
const prismaError = code => new Prisma.PrismaClientKnownRequestError('private details', { code, clientVersion: '7.10.0' });
test('database duplicate race becomes 409', async () => {
  setup('OWNER', 'MEMBER', false);
  db.householdMember.create = mock.fn(async () => { throw prismaError('P2002'); });
  assert.equal((await request('POST', { userId: 'target' })).status, 409);
});
test('serialization retry rechecks permission after actor is demoted', async () => {
  setup('ADMIN', 'MEMBER', false);
  db.householdMember.create = mock.fn(async () => {
    db.householdMember.findUnique = mock.fn(async () => ({ role: 'MEMBER' }));
    throw prismaError('P2034');
  });
  assert.equal((await request('POST', { userId: 'target' })).status, 403);
  assert.equal(db.householdMember.create.mock.callCount(), 1);
});
test('serialization retries are bounded', async () => {
  setup('OWNER', 'MEMBER', false);
  db.householdMember.create = mock.fn(async () => { throw prismaError('P2034'); });
  assert.equal((await request('POST', { userId: 'target' })).status, 409);
  assert.equal(db.householdMember.create.mock.callCount(), 3);
});
test('unexpected errors do not expose database details', async () => {
  setup();
  mock.method(console, 'error', () => {});
  db.householdMember.findUnique = mock.fn(async () => { throw new Error('private details'); });
  assert.deepEqual(await request('GET'), { status: 500, body: { message: 'Household member operation failed' } });
});


