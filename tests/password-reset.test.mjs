import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
import bcrypt from 'bcrypt';
process.env.JWT_SECRET = 'reset-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { mailer } = await import('../src/lib/mailer.ts');
const { generateCode, hashCode, INVALID_CODE, MAX_ATTEMPTS } = await import('../src/services/password-reset.service.ts');
const originalTransaction = prisma.$transaction;
let server, base, db, sent;
const email = 'praveen@example.com';
const user = { id: 'user-1', name: 'Praveen', password: 'old-hash' };
const sha = (code) => createHash('sha256').update(code).digest('hex');
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
afterEach(() => { prisma.$transaction = originalTransaction; mock.restoreAll(); });
after(async () => {
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await prisma.$disconnect();
});
// exists: whether the email belongs to an account. reset: the live reset row, or null.
// lastRequestAgo: seconds since the previous code was issued, for the cooldown.
function setup({ exists = true, reset = null, lastRequestAgo = null, mailFails = false } = {}) {
  mock.restoreAll();
  db = {
    user: {
      findUnique: mock.fn(async ({ where }) => { assert.equal(where.email, email); return exists ? user : null; }),
      update: mock.fn(async ({ data }) => ({ ...user, ...data })),
    },
    passwordReset: {
      findFirst: mock.fn(async ({ where, orderBy }) => {
        assert.equal(where.userId, 'user-1');
        assert.deepEqual(orderBy, { createdAt: 'desc' });
        if (where.usedAt === null) return reset;
        return lastRequestAgo === null ? null : { createdAt: new Date(Date.now() - lastRequestAgo * 1000) };
      }),
      deleteMany: mock.fn(async () => ({ count: 1 })),
      create: mock.fn(async ({ data }) => ({ id: 'reset-1', ...data })),
      update: mock.fn(async ({ where, data }) => ({ id: where.id, ...data })),
    },
  };
  sent = mock.method(mailer, 'send', async () => { if (mailFails) throw new Error('smtp down'); });
  const transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  prisma.$transaction = transaction;
  return transaction;
}
async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const liveReset = (overrides = {}) => ({ id: 'reset-1', codeHash: sha('123456'), expiresAt: new Date(Date.now() + 10 * 60_000), attempts: 0, ...overrides });
const GENERIC = { message: 'If that email is registered, a reset code is on its way' };

test('codes are six zero-padded digits and hash with SHA-256', () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
  assert.equal(hashCode('000123'), sha('000123'));
});

// ---- forgot-password ----
test('forgot-password validates the email before touching anything', async () => {
  const tx = setup();
  for (const body of [undefined, {}, { email: '' }, { email: 'not-an-email' }, { email: 5 }, { email: 'a@b' }]) {
    assert.deepEqual(await post('/forgot-password', body), { status: 400, body: { message: 'A valid email address is required' } }, JSON.stringify(body));
  }
  assert.equal(tx.mock.callCount(), 0);
});
test('forgot-password emails a fresh code and stores only its hash', async () => {
  setup();
  assert.deepEqual(await post('/forgot-password', { email }), { status: 200, body: GENERIC });
  assert.equal(sent.mock.callCount(), 1);
  const mail = sent.mock.calls[0].arguments[0];
  assert.equal(mail.to, email);
  assert.match(mail.subject, /password reset code/);
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  assert.match(mail.text, /Hi Praveen/);
  assert.match(mail.text, /15 minutes/);
  assert.deepEqual(db.passwordReset.deleteMany.mock.calls[0].arguments[0], { where: { userId: 'user-1' } });
  const stored = db.passwordReset.create.mock.calls[0].arguments[0].data;
  assert.equal(stored.userId, 'user-1');
  assert.equal(stored.codeHash, sha(code));
  assert.equal(stored.codeHash.includes(code), false, 'the code itself is never stored');
  const ttl = stored.expiresAt.getTime() - Date.now();
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, 'expires in 15 minutes');
});
test('forgot-password answers the same for an unknown email and sends nothing', async () => {
  setup({ exists: false });
  assert.deepEqual(await post('/forgot-password', { email }), { status: 200, body: GENERIC });
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(db.passwordReset.create.mock.callCount(), 0);
});
test('forgot-password ignores a repeat within the cooldown but allows one after it', async () => {
  setup({ lastRequestAgo: 30 });
  assert.deepEqual(await post('/forgot-password', { email }), { status: 200, body: GENERIC });
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(db.passwordReset.create.mock.callCount(), 0);
  setup({ lastRequestAgo: 61 });
  assert.equal((await post('/forgot-password', { email })).status, 200);
  assert.equal(sent.mock.callCount(), 1);
});
test('forgot-password reports a mail failure and retires the unsent code', async () => {
  setup({ mailFails: true });
  mock.method(console, 'error', () => {});
  assert.deepEqual(await post('/forgot-password', { email }), { status: 503, body: { message: 'Could not send the email. Please try again later.' } });
  // Once to replace older codes, once more to retire the one that could not be sent.
  assert.equal(db.passwordReset.deleteMany.mock.callCount(), 2);
});

// ---- reset-password ----
const validBody = { email, code: '123456', password: 'new-password-1' };
test('reset-password validates the body before touching anything', async () => {
  const tx = setup();
  const cases = [
    [{}, 'A valid email address is required'],
    [{ ...validBody, email: 'nope' }, 'A valid email address is required'],
    [{ ...validBody, code: '12345' }, 'Enter the 6-digit code from the email'],
    [{ ...validBody, code: 123456 }, 'Enter the 6-digit code from the email'],
    [{ ...validBody, code: '12 3456' }, 'Enter the 6-digit code from the email'],
    [{ ...validBody, password: 'short' }, 'Password must be at least 8 characters'],
    [{ ...validBody, password: 7 }, 'Password must be at least 8 characters'],
    [{ ...validBody, password: 'x'.repeat(73) }, 'Password must be at most 72 characters'],
  ];
  for (const [body, message] of cases) assert.deepEqual(await post('/reset-password', body), { status: 400, body: { message } }, JSON.stringify(body));
  assert.equal(tx.mock.callCount(), 0);
});
test('reset-password with the live code stores a bcrypt hash and marks the code used', async () => {
  setup({ reset: liveReset() });
  assert.deepEqual(await post('/reset-password', validBody), { status: 200, body: { message: 'Password updated. You can sign in with your new password.' } });
  const update = db.user.update.mock.calls[0].arguments[0];
  assert.deepEqual(update.where, { id: 'user-1' });
  assert.notEqual(update.data.password, 'new-password-1');
  assert.equal(await bcrypt.compare('new-password-1', update.data.password), true);
  const used = db.passwordReset.update.mock.calls[0].arguments[0];
  assert.deepEqual(used.where, { id: 'reset-1' });
  assert.ok(used.data.usedAt instanceof Date);
});
test('reset-password with a wrong code counts the attempt and keeps the password', async () => {
  setup({ reset: liveReset() });
  assert.deepEqual(await post('/reset-password', { ...validBody, code: '654321' }), { status: 400, body: { message: INVALID_CODE } });
  assert.deepEqual(db.passwordReset.update.mock.calls[0].arguments[0], { where: { id: 'reset-1' }, data: { attempts: { increment: 1 } } });
  assert.equal(db.user.update.mock.callCount(), 0);
});
test('reset-password refuses expired, exhausted, missing, and unknown-account codes alike', async () => {
  const refused = [
    ['expired', { reset: liveReset({ expiresAt: new Date(Date.now() - 1000) }) }],
    ['exhausted', { reset: liveReset({ attempts: MAX_ATTEMPTS }) }],
    ['no code issued', { reset: null }],
    ['unknown account', { exists: false }],
  ];
  for (const [label, options] of refused) {
    setup(options);
    assert.deepEqual(await post('/reset-password', validBody), { status: 400, body: { message: INVALID_CODE } }, label);
    assert.equal(db.user.update.mock.callCount(), 0, label);
    assert.equal(db.passwordReset.update.mock.callCount(), 0, `${label}: nothing to count against`);
  }
});
test('reset-password only considers unused codes, newest first', async () => {
  setup({ reset: liveReset() });
  await post('/reset-password', validBody);
  const lookup = db.passwordReset.findFirst.mock.calls[0].arguments[0];
  assert.deepEqual(lookup.where, { userId: 'user-1', usedAt: null });
});
test('unexpected errors do not expose details', async () => {
  setup();
  mock.method(console, 'error', () => {});
  db.user.findUnique = mock.fn(async () => { throw new Error('private details'); });
  assert.deepEqual(await post('/forgot-password', { email }), { status: 500, body: { message: 'Could not start the password reset' } });
  assert.deepEqual(await post('/reset-password', validBody), { status: 500, body: { message: 'Could not reset the password' } });
});
