import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
process.env.JWT_SECRET = 'google-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.GOOGLE_CLIENT_IDS = 'homehub-client';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { googleClient, verifyGoogleToken } = await import('../src/lib/google-auth.ts');
const { signToken, verifyToken } = await import('../src/lib/jwt.ts');
const { Prisma } = await import('../generated/prisma/client.ts');
const { mailer } = await import('../src/lib/mailer.ts');
const originalTransaction = prisma.$transaction;
const originalFindUnique = prisma.user.findUnique;
const password = 'Password123!';
const passwordHash = await bcrypt.hash(password, 10);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const googleProfile = { sub: 'google-123', email: 'alice@gmail.com', email_verified: true, name: 'Alice' };
function googleToken(overrides = {}, key = privateKey) {
  return jwt.sign({
    ...googleProfile, iss: 'https://accounts.google.com', aud: 'homehub-client',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }, key, { algorithm: 'RS256', keyid: 'test-key' });
}
let server, base, db, linked, collision, local;
const auth = signToken({ userId: 'local-id', email: 'alice@gmail.com' });
const safe = { id: 'local-id', name: 'Alice', email: 'alice@gmail.com' };
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
beforeEach(() => {
  process.env.GOOGLE_CLIENT_IDS = 'homehub-client';
  // Use real signature/claim verification with a local test key; no Google network call.
  mock.method(googleClient, 'getFederatedSignonCertsAsync', async () => ({ certs: { 'test-key': pem }, format: 'PEM' }));
  linked = null;
  collision = null;
  local = { ...safe, password: passwordHash, googleId: null };
  db = { user: {
    findUnique: mock.fn(async ({ where }) => where.googleId ? linked : local),
    findFirst: mock.fn(async ({ where }) => {
      assert.deepEqual(where, { email: { equals: 'alice@gmail.com', mode: 'insensitive' } });
      return collision;
    }),
    create: mock.fn(async ({ data, select }) => {
      assert.equal(data.googleId, 'google-123');
      assert.equal(data.password, undefined);
      assert.deepEqual(select, { id: true, name: true, email: true, avatarUrl: true });
      return safe;
    }),
    update: mock.fn(async ({ where, data, select }) => {
      assert.deepEqual(where, { id: 'local-id' });
      assert.deepEqual(data, { googleId: 'google-123' });
      assert.deepEqual(select, { id: true, name: true, email: true, avatarUrl: true });
      return safe;
    }),
  } };
  prisma.$transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
});
afterEach(() => {
  prisma.$transaction = originalTransaction;
  prisma.user.findUnique = originalFindUnique;
  mock.restoreAll();
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
});
async function post(path, body, token) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('new Google user receives a safe user response and HomeHub token', async () => {
  const result = await post('/google', { idToken: googleToken(), email: 'attacker@example.com', userId: 'other' });
  assert.equal(result.status, 201);
  assert.equal(result.body.isNewUser, true);
  assert.deepEqual(result.body.user, safe);
  assert.equal(verifyToken(result.body.token).userId, safe.id);
  assert.equal(db.user.create.mock.callCount(), 1);
});
test('existing Google subject logs into the same user even when email changes', async () => {
  linked = safe;
  const result = await post('/google', { idToken: googleToken({ email: 'changed@gmail.com' }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.isNewUser, false);
  assert.deepEqual(result.body.user, safe);
  assert.equal(db.user.findFirst.mock.callCount(), 0);
  assert.equal(db.user.create.mock.callCount(), 0);
});
test('existing email requires linking and is never silently merged', async () => {
  collision = { id: 'existing' };
  assert.equal((await post('/google', { idToken: googleToken({ email: 'ALICE@gmail.com' }) })).status, 409);
  assert.equal(db.user.create.mock.callCount(), 0);
  assert.equal(db.user.update.mock.callCount(), 0);
});
test('missing or malformed request tokens are rejected before database access', async () => {
  for (const idToken of [undefined, null, '', 123, 'x'.repeat(10001)]) {
    assert.equal((await post('/google', { idToken })).status, 400);
  }
  assert.equal(prisma.$transaction.mock.callCount(), 0);
});
test('real Google verification rejects bad signature, audience, issuer, expiry and unverified email', async () => {
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const tokens = [
    'invalid', googleToken({}, otherKey), googleToken({ aud: 'another-app' }),
    googleToken({ iss: 'https://attacker.example' }),
    googleToken({ iat: 100, exp: 200 }), googleToken({ email_verified: false }),
    googleToken({ email: '' }), googleToken({ sub: '' }),
  ];
  for (const idToken of tokens) {
    assert.equal((await post('/google', { idToken })).status, 401);
  }
  assert.equal(prisma.$transaction.mock.callCount(), 0);
});
test('missing configuration disables only Google authentication', async () => {
  delete process.env.GOOGLE_CLIENT_IDS;
  assert.equal((await post('/google', { idToken: googleToken() })).status, 503);
  assert.equal(prisma.$transaction.mock.callCount(), 0);
  prisma.user.findUnique = async () => local;
  assert.equal((await post('/login', { email: safe.email, password })).status, 200);
});
test('allowlisted multiple audiences and absent display name work', async () => {
  process.env.GOOGLE_CLIENT_IDS = 'first-client, homehub-client';
  const profile = await verifyGoogleToken(googleToken({ name: '' }));
  assert.equal(profile.name, 'HomeHub user');
});
test('link requires HomeHub authentication before verifying Google', async () => {
  assert.equal((await post('/google/link', { idToken: googleToken(), password })).status, 401);
  assert.equal(prisma.$transaction.mock.callCount(), 0);
});
test('link preserves account identity and password, and repeating it succeeds', async () => {
  for (const alreadyLinked of [false, true]) {
    local.googleId = alreadyLinked ? 'google-123' : null;
    linked = alreadyLinked ? { id: safe.id } : null;
    const result = await post('/google/link', { idToken: googleToken(), password, userId: 'other' }, auth);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.user, safe);
    assert.equal(local.password, passwordHash);
  }
});
test('link rejects missing/wrong password, mismatched email, or another linked account', async () => {
  assert.equal((await post('/google/link', { idToken: googleToken() }, auth)).status, 400);
  assert.equal((await post('/google/link', { idToken: googleToken(), password: 'wrong' }, auth)).status, 401);
  assert.equal((await post('/google/link', { idToken: googleToken({ email: 'bob@gmail.com' }), password }, auth)).status, 409);
  local.googleId = 'different-google';
  assert.equal((await post('/google/link', { idToken: googleToken(), password }, auth)).status, 409);
  local.googleId = null;
  linked = { id: 'another-user' };
  assert.equal((await post('/google/link', { idToken: googleToken(), password }, auth)).status, 409);
  assert.equal(db.user.update.mock.callCount(), 0);
});
test('Google-only accounts cannot use local login or request/reset a password', async () => {
  local.password = null;
  prisma.user.findUnique = async () => local;
  assert.equal((await post('/login', { email: safe.email, password })).status, 401);
  const send = mock.method(mailer, 'send', async () => {});
  const result = await post('/forgot-password', { email: safe.email });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, 'If that email is registered, a reset code is on its way');
  assert.equal(send.mock.callCount(), 0);
  assert.equal((await post('/reset-password', { email: safe.email, password, code: '123456' })).status, 400);
  assert.equal(db.user.update.mock.callCount(), 0);
});
test('concurrent unique conflicts return 409 and unexpected failures stay private', async () => {
  db.user.create = async () => { throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7.10.0' }); };
  assert.equal((await post('/google', { idToken: googleToken() })).status, 409);
  db.user.create = async () => { throw new Error('private database details'); };
  assert.deepEqual(await post('/google', { idToken: googleToken() }), {
    status: 500, body: { message: 'Google authentication failed' },
  });
});
