import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'profile-picture-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
// Fake credentials: URLs become predictable and nothing can reach Cloudinary.
process.env.CLOUDINARY_URL = 'cloudinary://test-key:test-secret@test-cloud';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { imageStorage, isHouseholdImage, isImageIn, avatarFolder, pictureFolder, profileImageUrl } = await import('../src/lib/cloudinary.ts');
const { userFields, userSummary, chatUserSummary } = await import('../src/lib/user-select.ts');
const { messageSelect } = await import('../src/services/chat.service.ts');

const originalTransaction = prisma.$transaction;
let server, base, db, destroy;
const token = signToken({ userId: 'actor', email: 'actor@example.com' });
const uuid = '0f0d3c1e-1111-4222-8333-444455556666';
const otherUuid = '1a2b3c4d-1111-4222-8333-444455556666';
const avatarId = `homehub/users/actor/${uuid}`;
const pictureId = `homehub/households/home/picture/${uuid}`;
const delivery = (gravity, id) => `https://res.cloudinary.com/test-cloud/image/upload/c_fill,g_${gravity},w_400,h_400,f_auto,q_auto/${id}`;
const householdSelect = { id: true, name: true, createdAt: true, pictureUrl: true };

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(() => { prisma.$transaction = originalTransaction; mock.restoreAll(); });
after(async () => {
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await prisma.$disconnect();
});

// role: the requester's role in the household, or null when they are not a member.
// avatar / picture: the public ID stored before the request. exists: whether the account still exists.
function setup({ role = 'OWNER', avatar = null, picture = null, exists = true } = {}) {
  mock.restoreAll();
  const account = { id: 'actor', name: 'Actor', email: 'actor@example.com' };
  db = {
    user: {
      findUnique: mock.fn(async ({ select }) => {
        if (!exists) return null;
        return select.avatarPublicId ? { avatarPublicId: avatar } : { ...account, avatarUrl: avatar && delivery('face', avatar) };
      }),
      update: mock.fn(async ({ data }) => ({ ...account, avatarUrl: data.avatarUrl })),
    },
    householdMember: { findUnique: mock.fn(async () => (role ? { id: 'membership', role } : null)) },
    household: {
      findUnique: mock.fn(async () => ({ picturePublicId: picture })),
      update: mock.fn(async ({ data }) => ({ id: 'home', name: 'Home', createdAt: '2026-09-01T00:00:00.000Z', pictureUrl: data.pictureUrl })),
    },
  };
  destroy = mock.method(imageStorage, 'destroy', async () => {});
  prisma.$transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  return prisma.$transaction;
}
async function request(method, path, body, auth = `Bearer ${token}`) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

// ---- one place decides how a person looks ----
test('every public user select carries the avatar and never a secret', () => {
  assert.deepEqual(userFields, { id: true, name: true, email: true, avatarUrl: true });
  assert.deepEqual(userSummary, { select: userFields });
  // Chat leaves the email address out, and its messages reach phones through the same select.
  assert.deepEqual(chatUserSummary, { select: { id: true, name: true, avatarUrl: true } });
  assert.equal(messageSelect.sender, chatUserSummary);
  for (const fields of [userFields, chatUserSummary.select]) {
    for (const secret of ['password', 'googleId', 'avatarPublicId']) assert.equal(secret in fields, false);
  }
});

// ---- folders keep the three kinds of image apart ----
test('an avatar, a household picture and a task photo can never stand in for one another', () => {
  assert.equal(isImageIn(avatarFolder('actor'), avatarId), true);
  assert.equal(isImageIn(pictureFolder('home'), pictureId), true);
  // A household picture is not a task or expense photo, and the reverse.
  assert.equal(isHouseholdImage('home', pictureId), false);
  assert.equal(isImageIn(pictureFolder('home'), `homehub/households/home/${uuid}`), false);
  // Someone else's folder, a deeper path, a traversal and a non-UUID name are all refused.
  for (const id of [`homehub/users/other/${uuid}`, `${avatarId}/extra`, `homehub/users/actor/../other/${uuid}`, 'homehub/users/actor/avatar', '', avatarId.toUpperCase()]) {
    assert.equal(isImageIn(avatarFolder('actor'), id), false, id);
  }
  assert.equal(profileImageUrl(avatarId, 'face'), delivery('face', avatarId));
});

// ---- authentication ----
const endpoints = [
  ['GET', '/users/me'], ['POST', '/users/me/avatar/uploads'], ['PUT', '/users/me/avatar', { publicId: avatarId }], ['DELETE', '/users/me/avatar'],
  ['POST', '/households/home/picture/uploads'], ['PUT', '/households/home/picture', { publicId: pictureId }], ['DELETE', '/households/home/picture'],
];
for (const [method, path, body] of endpoints) {
  test(`${method} ${path} requires authentication`, async () => {
    const tx = setup();
    assert.equal((await request(method, path, body, null)).status, 401);
    assert.equal(tx.mock.callCount(), 0);
  });
}

// ---- the signed-in user's profile ----
test('GET /users/me returns the safe profile, and a token for a deleted account is refused', async () => {
  setup({ avatar: avatarId });
  const { status, body } = await request('GET', '/users/me');
  assert.equal(status, 200);
  assert.deepEqual(body.user, { id: 'actor', name: 'Actor', email: 'actor@example.com', avatarUrl: delivery('face', avatarId) });
  assert.deepEqual(db.user.findUnique.mock.calls[0].arguments[0], { where: { id: 'actor' }, select: userFields });
  setup({ exists: false });
  assert.deepEqual(await request('GET', '/users/me'), { status: 401, body: { message: 'Account no longer exists' } });
});

test('an avatar ticket is signed for the user\'s own folder', async () => {
  setup();
  const { status, body } = await request('POST', '/users/me/avatar/uploads');
  assert.equal(status, 201);
  assert.match(body.upload.publicId, /^homehub\/users\/actor\/[0-9a-f-]{36}$/);
  assert.equal(body.upload.fields.asset_folder, 'homehub/users/actor');
  assert.equal(body.upload.fields.public_id, body.upload.publicId);
});

test('setting an avatar stores the ID with a face-centred URL and deletes the old file after the commit', async () => {
  const previous = `homehub/users/actor/${otherUuid}`;
  setup({ avatar: previous });
  const { status, body } = await request('PUT', '/users/me/avatar', { publicId: avatarId });
  assert.equal(status, 200);
  assert.deepEqual(body.user, { id: 'actor', name: 'Actor', email: 'actor@example.com', avatarUrl: delivery('face', avatarId) });
  assert.deepEqual(db.user.update.mock.calls[0].arguments[0], {
    where: { id: 'actor' }, data: { avatarPublicId: avatarId, avatarUrl: delivery('face', avatarId) }, select: userFields,
  });
  assert.deepEqual(destroy.mock.calls.map(call => call.arguments[0]), [[previous]]);
});

test('setting the same avatar again, or a first avatar, deletes nothing', async () => {
  setup({ avatar: avatarId });
  assert.equal((await request('PUT', '/users/me/avatar', { publicId: avatarId })).status, 200);
  setup();
  assert.equal((await request('PUT', '/users/me/avatar', { publicId: avatarId })).status, 200);
  assert.equal(destroy.mock.callCount(), 0);
});

test('an avatar must be a file signed for this account', async () => {
  for (const publicId of [`homehub/users/other/${uuid}`, pictureId, `homehub/households/home/${uuid}`, 'anything']) {
    const tx = setup();
    assert.deepEqual(await request('PUT', '/users/me/avatar', { publicId }), { status: 400, body: { message: 'Image does not belong to this account' } });
    assert.equal(tx.mock.callCount(), 0);
  }
  setup();
  assert.deepEqual(await request('PUT', '/users/me/avatar', {}), { status: 400, body: { message: 'Image public ID is required' } });
});

test('removing an avatar clears both columns and deletes the file', async () => {
  setup({ avatar: avatarId });
  const { status, body } = await request('DELETE', '/users/me/avatar');
  assert.equal(status, 200);
  assert.equal(body.user.avatarUrl, null);
  assert.deepEqual(db.user.update.mock.calls[0].arguments[0].data, { avatarPublicId: null, avatarUrl: null });
  assert.deepEqual(destroy.mock.calls.map(call => call.arguments[0]), [[avatarId]]);
});

// ---- the household's picture ----
for (const role of ['OWNER', 'ADMIN']) {
  test(`${role} can set the household picture and receives the household as the list shows it`, async () => {
    const previous = `homehub/households/home/picture/${otherUuid}`;
    setup({ role, picture: previous });
    const ticket = await request('POST', '/households/home/picture/uploads');
    assert.equal(ticket.status, 201);
    assert.match(ticket.body.upload.publicId, /^homehub\/households\/home\/picture\/[0-9a-f-]{36}$/);
    const { status, body } = await request('PUT', '/households/home/picture', { publicId: pictureId });
    assert.equal(status, 200);
    assert.deepEqual(body.household, { id: 'home', name: 'Home', createdAt: '2026-09-01T00:00:00.000Z', pictureUrl: delivery('auto', pictureId), role });
    assert.deepEqual(db.household.update.mock.calls[0].arguments[0], {
      where: { id: 'home' }, data: { picturePublicId: pictureId, pictureUrl: delivery('auto', pictureId) }, select: householdSelect,
    });
    assert.deepEqual(destroy.mock.calls.map(call => call.arguments[0]), [[previous]]);
  });
}

test('a MEMBER can see the picture but cannot sign, set or remove it', async () => {
  for (const [method, path, body] of endpoints.slice(4)) {
    setup({ role: 'MEMBER', picture: pictureId });
    assert.deepEqual(await request(method, path, body), { status: 403, body: { message: 'Only owners and admins can change the household picture' } });
    assert.equal(db.household.update.mock.callCount(), 0);
    assert.equal(destroy.mock.callCount(), 0);
  }
});

test('a nonmember learns nothing about the household', async () => {
  for (const [method, path, body] of endpoints.slice(4)) {
    setup({ role: null });
    assert.deepEqual(await request(method, path, body), { status: 404, body: { message: 'Household not found or access denied' } });
    assert.equal(db.household.findUnique.mock.callCount(), 0);
  }
});

test('a household picture must be a file signed for that household\'s picture folder', async () => {
  for (const publicId of [`homehub/households/other/picture/${uuid}`, `homehub/households/home/${uuid}`, avatarId]) {
    const tx = setup();
    assert.deepEqual(await request('PUT', '/households/home/picture', { publicId }), { status: 400, body: { message: 'Image does not belong to this household' } });
    assert.equal(tx.mock.callCount(), 0);
  }
});

test('removing the household picture clears both columns and deletes the file', async () => {
  setup({ role: 'ADMIN', picture: pictureId });
  const { status, body } = await request('DELETE', '/households/home/picture');
  assert.equal(status, 200);
  assert.equal(body.household.pictureUrl, null);
  assert.deepEqual(db.household.update.mock.calls[0].arguments[0].data, { picturePublicId: null, pictureUrl: null });
  assert.deepEqual(destroy.mock.calls.map(call => call.arguments[0]), [[pictureId]]);
});
