import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'invitation-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { Prisma } = await import('../generated/prisma/client.ts');
const originalTransaction = prisma.$transaction;
let server, api, db;
// 'actor' is whoever holds the token: the inviter on the household side, the invited user on /api/invitations.
const token = signToken({ userId: 'actor', email: 'actor@example.com' });
const userSelect = { select: { id: true, name: true, email: true } };
const invitationSelect = { id: true, role: true, createdAt: true, household: { select: { id: true, name: true } }, invitedUser: userSelect, invitedBy: userSelect };
const invitationOrder = [{ createdAt: 'desc' }, { id: 'desc' }];
const household = { id: 'home', name: 'Family Home' };
const invitation = {
  id: 'inv-1', role: 'MEMBER', createdAt: '2026-09-20T00:00:00.000Z', household,
  invitedUser: { id: 'target', name: 'Target', email: 'target@example.com' },
  invitedBy: { id: 'actor', name: 'Actor', email: 'actor@example.com' },
};
const member = { id: 'membership', role: 'MEMBER', user: { id: 'actor', name: 'Actor', email: 'actor@example.com' } };
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  api = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(() => { prisma.$transaction = originalTransaction; mock.restoreAll(); });
after(async () => {
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await prisma.$disconnect();
});
// actor: the token holder's role in the household, or null when they are not a member.
// targetIsMember / pending: what the invite checks find. stored: the invitation findFirst returns, or null.
// inviterRole: the sender's role when an invitation is answered, or null once they have left.
function setup({ actor = 'OWNER', targetIsMember = false, pending = false, stored = {}, inviterRole = 'OWNER' } = {}) {
  db = {
    notification: { create: mock.fn(async ({ data }) => ({ id: 'notice', ...data })) },
    user: { findUnique: mock.fn(async ({ where }) => (where.id === 'actor' ? { name: 'Actor' } : { id: 'target' })) },
    householdMember: {
      findUnique: mock.fn(async ({ where }) => {
        const key = where.userId_householdId;
        assert.equal(key.householdId, 'home');
        if (key.userId === 'actor') return actor ? { id: 'actor-membership', role: actor } : null;
        if (key.userId === 'inviter') return inviterRole ? { id: 'inviter-membership', role: inviterRole } : null;
        return targetIsMember ? { id: 'target-membership' } : null;
      }),
      create: mock.fn(async () => member),
    },
    householdInvitation: {
      findUnique: mock.fn(async ({ where }) => {
        assert.deepEqual(where, { householdId_invitedUserId: { householdId: 'home', invitedUserId: 'target' } });
        return pending ? { id: 'inv-1' } : null;
      }),
      findFirst: mock.fn(async () => (stored ? { id: 'inv-1', householdId: 'home', invitedById: 'inviter', role: 'MEMBER', household, ...stored } : null)),
      findMany: mock.fn(async () => [invitation]),
      create: mock.fn(async () => invitation),
      delete: mock.fn(async () => invitation),
    },
  };
  const transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  prisma.$transaction = transaction;
  return transaction;
}
async function request(method, path, body, auth = `Bearer ${token}`) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const HOME = '/households/home/invitations';
const invite = (body, auth) => request('POST', HOME, body, auth);
const prismaError = code => new Prisma.PrismaClientKnownRequestError('private details', { code, clientVersion: '7.10.0' });
const notices = () => db.notification.create.mock.calls.map(call => call.arguments[0].data);

const endpoints = [['GET', HOME], ['POST', HOME], ['DELETE', `${HOME}/inv-1`], ['GET', '/invitations'], ['POST', '/invitations/inv-1/accept'], ['POST', '/invitations/inv-1/decline']];
for (const [method, path] of endpoints) {
  test(`${method} ${path} requires authentication`, async () => {
    const tx = setup();
    assert.equal((await request(method, path, { userId: 'target' }, null)).status, 401);
    assert.equal(tx.mock.callCount(), 0);
  });
}
for (const [method, path] of endpoints.slice(0, 3)) {
  test(`${method} ${path} denies nonmembers before touching invitations`, async () => {
    setup({ actor: null });
    assert.deepEqual(await request(method, path, { userId: 'target' }), { status: 404, body: { message: 'Household not found or access denied' } });
    for (const fn of Object.values(db.householdInvitation)) assert.equal(fn.mock.callCount(), 0);
    assert.equal(db.user.findUnique.mock.callCount(), 0);
  });
}

// ---- Inviting ----

for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  for (const role of ['ADMIN', 'MEMBER']) {
    test(`${actor} inviting as ${role} follows permissions`, async () => {
      setup({ actor });
      const allowed = actor === 'OWNER' || (actor === 'ADMIN' && role === 'MEMBER');
      assert.equal((await invite({ userId: 'target', role })).status, allowed ? 201 : 403);
      assert.equal(db.householdInvitation.create.mock.callCount(), allowed ? 1 : 0);
      // Permissions are settled before the invited user is looked up.
      if (!allowed) assert.equal(db.user.findUnique.mock.callCount(), 0);
    });
  }
}
test('invite validates the body before accessing the database', async () => {
  const tx = setup();
  for (const body of [undefined, {}, { userId: '' }, { userId: 1 }, { userId: 'target', role: 'OWNER' }, { userId: 'target', role: null }, { email: '' }, { email: 42 }, { email: 'target@example.com', role: 'OWNER' }, { userId: 'target', email: 'target@example.com' }]) {
    assert.equal((await invite(body)).status, 400);
  }
  assert.deepEqual((await invite({})).body, { message: 'User ID or email address is required' });
  assert.deepEqual((await invite({ userId: 'target', email: 'target@example.com' })).body, { message: 'Provide either a user ID or an email address, not both' });
  assert.equal(tx.mock.callCount(), 0);
});
test('invite resolves a trimmed email, saves a pending invitation and creates no membership', async () => {
  setup();
  db.user.findUnique = mock.fn(async ({ where, select }) => {
    assert.deepEqual(where, { email: 'target@example.com' });
    assert.deepEqual(select, { id: true });
    return { id: 'target' };
  });
  assert.deepEqual(await invite({ email: ' target@example.com ', role: 'ADMIN', householdId: 'other', invitedById: 'owner' }), { status: 201, body: { message: 'Invitation sent successfully', invitation } });
  const created = db.householdInvitation.create.mock.calls[0].arguments[0];
  // The household comes from the URL and the sender from the token, never the body.
  assert.deepEqual(created.data, { householdId: 'home', invitedUserId: 'target', invitedById: 'actor', role: 'ADMIN' });
  assert.deepEqual(created.select, invitationSelect);
  assert.equal(db.householdMember.create.mock.callCount(), 0);
});
test('invite defaults to MEMBER', async () => {
  setup({ actor: 'ADMIN' });
  assert.equal((await invite({ userId: 'target' })).status, 201);
  assert.equal(db.householdInvitation.create.mock.calls[0].arguments[0].data.role, 'MEMBER');
});
test('invite returns 404 for unknown users and 409 for members and pending invitations', async () => {
  setup();
  db.user.findUnique = mock.fn(async () => null);
  assert.deepEqual(await invite({ email: 'unknown@example.com' }), { status: 404, body: { message: 'User not found' } });
  setup({ targetIsMember: true });
  assert.deepEqual(await invite({ userId: 'target' }), { status: 409, body: { message: 'User is already a household member' } });
  assert.equal(db.householdInvitation.findUnique.mock.callCount(), 0);
  setup({ pending: true });
  assert.deepEqual(await invite({ userId: 'target' }), { status: 409, body: { message: 'User already has a pending invitation to this household' } });
  assert.equal(db.householdInvitation.create.mock.callCount(), 0);
  assert.equal(db.notification.create.mock.callCount(), 0);
});
test('invite notifies the invited user with the sender, household, role and invitation ID', async () => {
  for (const actor of ['OWNER', 'ADMIN']) {
    setup({ actor });
    assert.equal((await invite({ userId: 'target' })).status, 201);
    assert.deepEqual(notices(), [{
      userId: 'target', type: 'HOUSEHOLD_INVITATION', title: 'Household invitation',
      message: 'Actor wants to add you to Family Home as member.', householdId: 'home', entityId: 'inv-1',
    }]);
  }
});
test('a concurrent duplicate invitation becomes 409 and retries are bounded', async () => {
  setup();
  db.householdInvitation.create = mock.fn(async () => { throw prismaError('P2002'); });
  assert.deepEqual(await invite({ userId: 'target' }), { status: 409, body: { message: 'User is already a member or already invited' } });
  setup();
  db.householdInvitation.create = mock.fn(async () => { throw prismaError('P2034'); });
  assert.equal((await invite({ userId: 'target' })).status, 409);
  assert.equal(db.householdInvitation.create.mock.callCount(), 3);
});
test('serialization retry rechecks permission after the sender is demoted', async () => {
  setup({ actor: 'ADMIN' });
  db.householdInvitation.create = mock.fn(async () => {
    db.householdMember.findUnique = mock.fn(async () => ({ role: 'MEMBER' }));
    throw prismaError('P2034');
  });
  assert.equal((await invite({ userId: 'target' })).status, 403);
  assert.equal(db.householdInvitation.create.mock.callCount(), 1);
});
test('a failed notification rejects the invitation before commit and hides the cause', async () => {
  setup();
  mock.method(console, 'error', () => {});
  let committed = false;
  db.notification.create = async () => { throw new Error('private details'); };
  prisma.$transaction = async operation => {
    const result = await operation(db);
    committed = true;
    return result;
  };
  assert.deepEqual(await invite({ userId: 'target' }), { status: 500, body: { message: 'Household invitation operation failed' } });
  assert.equal(committed, false);
});

// ---- The household's pending list and cancelling ----

for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  test(`${actor} can list the household's pending invitations with safe fields`, async () => {
    setup({ actor });
    assert.deepEqual(await request('GET', HOME), { status: 200, body: { message: 'Household invitations fetched successfully', invitations: [invitation] } });
    assert.deepEqual(db.householdInvitation.findMany.mock.calls[0].arguments[0], { where: { householdId: 'home' }, select: invitationSelect, orderBy: invitationOrder });
  });
  for (const role of ['ADMIN', 'MEMBER']) {
    test(`${actor} cancelling a ${role} invitation follows permissions`, async () => {
      setup({ actor, stored: { role } });
      const allowed = actor === 'OWNER' || (actor === 'ADMIN' && role === 'MEMBER');
      assert.equal((await request('DELETE', `${HOME}/inv-1`)).status, allowed ? 200 : 403);
      assert.equal(db.householdInvitation.delete.mock.callCount(), allowed ? 1 : 0);
    });
  }
}
test('cancel looks the invitation up inside its household and returns 404 when missing', async () => {
  setup();
  assert.deepEqual(await request('DELETE', `${HOME}/inv-1`), { status: 200, body: { message: 'Invitation cancelled successfully' } });
  assert.deepEqual(db.householdInvitation.findFirst.mock.calls[0].arguments[0].where, { id: 'inv-1', householdId: 'home' });
  assert.deepEqual(db.householdInvitation.delete.mock.calls[0].arguments[0], { where: { id: 'inv-1' } });
  assert.equal(db.notification.create.mock.callCount(), 0);
  setup({ stored: null });
  assert.deepEqual(await request('DELETE', `${HOME}/inv-1`), { status: 404, body: { message: 'Invitation not found' } });
  assert.equal(db.householdInvitation.delete.mock.callCount(), 0);
});

// ---- The invited user's side ----

test('a user lists only their own pending invitations', async () => {
  setup({ actor: null });
  assert.deepEqual(await request('GET', '/invitations?userId=someone-else'), { status: 200, body: { message: 'Invitations fetched successfully', invitations: [invitation] } });
  assert.deepEqual(db.householdInvitation.findMany.mock.calls[0].arguments[0], { where: { invitedUserId: 'actor' }, select: invitationSelect, orderBy: invitationOrder });
});
test('accept creates the membership with the invited role, removes the invitation and tells the sender', async () => {
  for (const [inviterRole, role] of [['OWNER', 'ADMIN'], ['OWNER', 'MEMBER'], ['ADMIN', 'MEMBER']]) {
    setup({ actor: null, inviterRole, stored: { role } });
    assert.deepEqual(await request('POST', '/invitations/inv-1/accept'), { status: 200, body: { message: 'Invitation accepted successfully', member, household } });
    assert.deepEqual(db.householdInvitation.findFirst.mock.calls[0].arguments[0].where, { id: 'inv-1', invitedUserId: 'actor' });
    assert.deepEqual(db.householdMember.create.mock.calls[0].arguments[0].data, { householdId: 'home', userId: 'actor', role });
    assert.deepEqual(db.householdInvitation.delete.mock.calls[0].arguments[0], { where: { id: 'inv-1' } });
    assert.deepEqual(notices(), [{
      userId: 'inviter', type: 'MEMBER_JOINED', title: 'Invitation accepted',
      message: 'Actor accepted your invitation to Family Home.', householdId: 'home',
    }]);
  }
});
test('accept and decline return 404 for a missing or another user\'s invitation', async () => {
  for (const action of ['accept', 'decline']) {
    setup({ actor: null, stored: null });
    assert.deepEqual(await request('POST', `/invitations/inv-1/${action}`), { status: 404, body: { message: 'Invitation not found' } });
    assert.equal(db.householdMember.create.mock.callCount(), 0);
    assert.equal(db.householdInvitation.delete.mock.callCount(), 0);
    assert.equal(db.notification.create.mock.callCount(), 0);
  }
});
test('accept refuses an invitation its sender could no longer send', async () => {
  for (const [inviterRole, role] of [[null, 'MEMBER'], ['MEMBER', 'MEMBER'], ['ADMIN', 'ADMIN']]) {
    setup({ actor: null, inviterRole, stored: { role } });
    assert.deepEqual(await request('POST', '/invitations/inv-1/accept'), { status: 409, body: { message: 'This invitation is no longer valid. You can decline it.' } });
    assert.equal(db.householdMember.create.mock.callCount(), 0);
    assert.equal(db.householdInvitation.delete.mock.callCount(), 0);
  }
});
test('accept turns an existing membership into 409', async () => {
  setup({ actor: null });
  db.householdMember.create = mock.fn(async () => { throw prismaError('P2002'); });
  assert.equal((await request('POST', '/invitations/inv-1/accept')).status, 409);
});
test('a failed notification rejects the acceptance before commit', async () => {
  setup({ actor: null });
  mock.method(console, 'error', () => {});
  let committed = false;
  db.notification.create = async () => { throw new Error('private details'); };
  prisma.$transaction = async operation => {
    const result = await operation(db);
    committed = true;
    return result;
  };
  assert.deepEqual(await request('POST', '/invitations/inv-1/accept'), { status: 500, body: { message: 'Household invitation operation failed' } });
  assert.equal(committed, false);
});
test('decline removes the invitation without a membership and tells a sender who is still a member', async () => {
  setup({ actor: null });
  assert.deepEqual(await request('POST', '/invitations/inv-1/decline'), { status: 200, body: { message: 'Invitation declined successfully' } });
  assert.deepEqual(db.householdInvitation.delete.mock.calls[0].arguments[0], { where: { id: 'inv-1' } });
  assert.equal(db.householdMember.create.mock.callCount(), 0);
  assert.deepEqual(notices(), [{
    userId: 'inviter', type: 'INVITATION_DECLINED', title: 'Invitation declined',
    message: 'Actor declined your invitation to Family Home.', householdId: 'home',
  }]);
  // A sender who has left the household learns nothing more about it.
  setup({ actor: null, inviterRole: null });
  assert.equal((await request('POST', '/invitations/inv-1/decline')).status, 200);
  assert.equal(db.householdInvitation.delete.mock.callCount(), 1);
  assert.equal(db.notification.create.mock.callCount(), 0);
});
