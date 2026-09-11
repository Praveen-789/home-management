import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'image-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
// Fake credentials: signatures become predictable and nothing can reach Cloudinary.
process.env.CLOUDINARY_URL = 'cloudinary://test-key:test-secret@test-cloud';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { Prisma } = await import('../generated/prisma/client.ts');
const { imageStorage, isHouseholdImage, signUploadParams } = await import('../src/lib/cloudinary.ts');
// Loaded the CommonJS way so this is the same SDK instance the library calls; the namespace from
// a dynamic import exposed a different `v2` object and mocks on it never fired.
const { v2: cloudinary } = createRequire(import.meta.url)('cloudinary');
const originalTransaction = prisma.$transaction;
let server, base, db, destroy;
const token = signToken({ userId: 'actor', email: 'actor@example.com' });
const userSelect = { select: { id: true, name: true, email: true } };
const imageSelect = { id: true, publicId: true, width: true, height: true, bytes: true, format: true, createdAt: true, uploadedBy: userSelect };
const imagesSelect = { select: imageSelect, orderBy: { createdAt: 'asc' } };
const publicId = 'homehub/households/home/0f0d3c1e-1111-4222-8333-444455556666';
const uploader = { id: 'actor', name: 'Actor', email: 'actor@example.com' };
// What Prisma returns for an image row, and what the API sends for it: URLs instead of the public ID.
const storedImage = { id: 'image-1', publicId, width: 1200, height: 900, bytes: 345678, format: 'jpg', createdAt: '2026-09-10T00:00:00.000Z', uploadedBy: uploader };
const viewImage = {
  id: 'image-1', width: 1200, height: 900, bytes: 345678, format: 'jpg', createdAt: '2026-09-10T00:00:00.000Z', uploadedBy: uploader,
  url: `https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto/${publicId}`,
  thumbnailUrl: `https://res.cloudinary.com/test-cloud/image/upload/c_fill,g_auto,w_400,h_400,f_auto,q_auto/${publicId}`,
};
const upload = { publicId, width: 1200, height: 900, bytes: 345678, format: 'jpg' };
const creator = { id: 'creator', name: 'Creator', email: 'creator@example.com' };
const baseTask = { id: 'task-1', householdId: 'home', title: 'Fix sink', description: null, status: 'TODO', priority: 'MEDIUM', dueDate: null, createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', createdBy: creator, assignedTo: null, images: [storedImage] };
const baseExpense = { id: 'expense-1', householdId: 'home', amount: new Prisma.Decimal('99.9'), description: 'Plumber', category: 'MAINTENANCE', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', paidBy: creator, createdBy: creator, task: null, images: [storedImage] };
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
// actor: the requester's role, or null when they are not a member. task / expense: who owns the stored rows.
function setup({ actor = 'OWNER', task = {}, expense = {}, imageCount = 0, duplicate = false, imageFound = true, parentImages = [publicId, `${publicId}-b`] } = {}) {
  // A test may call setup() more than once. Mocking destroy on top of an earlier mock would make
  // restoreAll put that earlier mock back instead of the real method, so start clean every time.
  mock.restoreAll();
  const taskRow = { ...baseTask, createdById: 'creator', assignedToId: 'assignee', ...task };
  const expenseRow = { ...baseExpense, createdById: 'creator', paidById: 'payer', ...expense };
  db = {
    taskRow,
    expenseRow,
    householdMember: {
      findUnique: mock.fn(async ({ where }) => {
        assert.equal(where.userId_householdId.householdId, 'home');
        return actor ? { id: 'actor-membership', role: actor } : null;
      }),
    },
    task: {
      findFirst: mock.fn(async ({ where }) => { assert.equal(where.householdId, 'home'); return taskRow; }),
      delete: mock.fn(async () => taskRow),
    },
    expense: {
      findFirst: mock.fn(async ({ where }) => { assert.equal(where.householdId, 'home'); return expenseRow; }),
      delete: mock.fn(async () => expenseRow),
    },
    image: {
      findUnique: mock.fn(async () => (duplicate ? { id: 'other-image' } : null)),
      count: mock.fn(async () => imageCount),
      create: mock.fn(async () => storedImage),
      findFirst: mock.fn(async ({ where }) => (imageFound ? { id: where.id, publicId } : null)),
      delete: mock.fn(async () => storedImage),
      findMany: mock.fn(async () => parentImages.map((id) => ({ publicId: id }))),
    },
  };
  destroy = mock.method(imageStorage, 'destroy', async () => {});
  const transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  prisma.$transaction = transaction;
  return transaction;
}
async function request(method, path, body, auth = `Bearer ${token}`) {
  const response = await fetch(`${base}/home${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const endpoints = [
  ['POST', '/uploads'],
  ['POST', '/tasks/task-1/images', upload],
  ['DELETE', '/tasks/task-1/images/image-1'],
  ['POST', '/expenses/expense-1/images', upload],
  ['DELETE', '/expenses/expense-1/images/image-1'],
];
for (const [method, path, body] of endpoints) {
  test(`${method} ${path} requires authentication`, async () => {
    const tx = setup();
    assert.equal((await request(method, path, body, null)).status, 401);
    assert.equal(tx.mock.callCount(), 0);
  });
  test(`${method} ${path} denies nonmembers before touching images`, async () => {
    setup({ actor: null });
    assert.deepEqual(await request(method, path, body), { status: 404, body: { message: 'Household not found or access denied' } });
    for (const fn of Object.values(db.image)) assert.equal(fn.mock.callCount(), 0);
    assert.equal(destroy.mock.callCount(), 0);
  });
}

// ---- upload tickets ----
test('a member receives a signed upload ticket for their household', async () => {
  setup({ actor: 'MEMBER' });
  const before = Math.floor(Date.now() / 1000);
  const { status, body } = await request('POST', '/uploads');
  assert.equal(status, 201);
  assert.equal(body.message, 'Upload authorized');
  const { uploadUrl, fields, publicId: issued, allowedFormats, expiresAt } = body.upload;
  assert.equal(uploadUrl, 'https://api.cloudinary.com/v1_1/test-cloud/image/upload');
  assert.match(issued, /^homehub\/households\/home\/[0-9a-f-]{36}$/);
  assert.equal(isHouseholdImage('home', issued), true);
  assert.deepEqual(allowedFormats, ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
  const timestamp = Number(fields.timestamp);
  assert.ok(timestamp >= before && timestamp <= before + 5, 'timestamp is now');
  assert.equal(expiresAt, new Date((timestamp + 3600) * 1000).toISOString());
  // The signed fields, and nothing else, travel with the file. Cloudinary recomputes this hash.
  const { api_key, signature, ...signed } = fields;
  assert.equal(api_key, 'test-key');
  assert.deepEqual(signed, { timestamp: String(timestamp), public_id: issued, asset_folder: 'homehub/households/home', allowed_formats: 'jpg,jpeg,png,webp,heic,heif', transformation: 'c_limit,w_2000,h_2000' });
  const expected = createHash('sha256')
    .update(`allowed_formats=jpg,jpeg,png,webp,heic,heif&asset_folder=homehub/households/home&public_id=${issued}&timestamp=${timestamp}&transformation=c_limit,w_2000,h_2000test-secret`)
    .digest('hex');
  assert.equal(signature, expected);
  assert.equal(signUploadParams({ timestamp, public_id: issued, asset_folder: 'homehub/households/home', allowed_formats: 'jpg,jpeg,png,webp,heic,heif', transformation: 'c_limit,w_2000,h_2000' }, 'test-secret'), expected);
});
test('every ticket names a different public ID', async () => {
  setup();
  const first = (await request('POST', '/uploads')).body.upload.publicId;
  const second = (await request('POST', '/uploads')).body.upload.publicId;
  assert.notEqual(first, second);
});
test('only public IDs signed for the household count as its images', () => {
  const uuid = '0f0d3c1e-1111-4222-8333-444455556666';
  assert.equal(isHouseholdImage('home', `homehub/households/home/${uuid}`), true);
  for (const id of [
    `homehub/households/other/${uuid}`, `homehub/households/home2/${uuid}`, `homehub/households/home/../other/${uuid}`,
    `homehub/households/home/${uuid}/extra`, 'homehub/households/home/', `${uuid}`, `evil/homehub/households/home/${uuid}`, '',
  ]) {
    assert.equal(isHouseholdImage('home', id), false, id);
  }
});

// ---- task images ----
const taskRelations = {
  creator: { createdById: 'actor', assignedToId: 'assignee' },
  assignee: { createdById: 'creator', assignedToId: 'actor' },
  bystander: { createdById: 'creator', assignedToId: 'assignee' },
};
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  for (const [relation, ownership] of Object.entries(taskRelations)) {
    const allowed = actor !== 'MEMBER' || ownership.createdById === 'actor' || ownership.assignedToId === 'actor';
    test(`${actor} as ${relation} adding and removing task images follows permissions`, async () => {
      setup({ actor, task: ownership });
      assert.equal((await request('POST', '/tasks/task-1/images', upload)).status, allowed ? 201 : 403);
      assert.equal(db.image.create.mock.callCount(), allowed ? 1 : 0);
      assert.equal((await request('DELETE', '/tasks/task-1/images/image-1')).status, allowed ? 200 : 403);
      assert.equal(db.image.delete.mock.callCount(), allowed ? 1 : 0);
    });
  }
}
test('a refused task image explains why', async () => {
  setup({ actor: 'MEMBER' });
  assert.deepEqual((await request('POST', '/tasks/task-1/images', upload)).body, { message: 'You can only manage images on tasks you created or are assigned to' });
});
test('adding a task image validates the body before accessing the database', async () => {
  const tx = setup();
  const invalid = [undefined, {}, { ...upload, publicId: '' }, { ...upload, publicId: 5 }, { ...upload, width: 0 }, { ...upload, width: 1.5 }, { ...upload, width: '1200' },
    { ...upload, height: 20001 }, { ...upload, bytes: 0 }, { ...upload, bytes: 20 * 1024 * 1024 + 1 }, { ...upload, format: 'gif' }, { ...upload, format: 7 }];
  for (const body of invalid) assert.equal((await request('POST', '/tasks/task-1/images', body)).status, 400, JSON.stringify(body));
  assert.deepEqual((await request('POST', '/tasks/task-1/images', {})).body, { message: 'Image public ID is required' });
  assert.deepEqual((await request('POST', '/tasks/task-1/images', { ...upload, width: 0 })).body, { message: 'Width must be an integer between 1 and 20000' });
  assert.deepEqual((await request('POST', '/tasks/task-1/images', { ...upload, bytes: 0 })).body, { message: 'Size in bytes must be an integer between 1 and 20971520' });
  assert.deepEqual((await request('POST', '/tasks/task-1/images', { ...upload, format: 'gif' })).body, { message: 'Format must be one of jpg, jpeg, png, webp, heic, heif' });
  assert.equal(tx.mock.callCount(), 0);
});
test('adding a task image records the upload against the task and returns the task with image URLs', async () => {
  setup();
  const { status, body } = await request('POST', '/tasks/task-1/images', { ...upload, format: 'JPG', extra: 'ignored' });
  assert.equal(status, 201);
  assert.deepEqual(body, { message: 'Image added successfully', task: { ...db.taskRow, images: [viewImage] } });
  assert.deepEqual(db.image.findUnique.mock.calls[0].arguments[0].where, { publicId });
  assert.deepEqual(db.image.count.mock.calls[0].arguments[0], { where: { taskId: 'task-1' } });
  assert.deepEqual(db.image.create.mock.calls[0].arguments[0].data, { ...upload, taskId: 'task-1', householdId: 'home', uploadedById: 'actor' });
  // The task is fetched again with the full select so the response carries every image.
  assert.deepEqual(db.task.findFirst.mock.calls[1].arguments[0].select.images, imagesSelect);
  assert.equal(destroy.mock.callCount(), 0);
});
test('adding a task image rejects public IDs from other households, duplicates, and a full task', async () => {
  setup();
  const foreign = { ...upload, publicId: 'homehub/households/other/0f0d3c1e-1111-4222-8333-444455556666' };
  assert.deepEqual(await request('POST', '/tasks/task-1/images', foreign), { status: 400, body: { message: 'Image does not belong to this household' } });
  setup({ duplicate: true });
  assert.deepEqual(await request('POST', '/tasks/task-1/images', upload), { status: 409, body: { message: 'This image is already attached' } });
  setup({ imageCount: 5 });
  assert.deepEqual(await request('POST', '/tasks/task-1/images', upload), { status: 400, body: { message: 'At most 5 images can be attached' } });
  assert.equal(db.image.create.mock.callCount(), 0);
});
test('removing a task image deletes the row, returns the task, and destroys the file afterwards', async () => {
  setup();
  const { status, body } = await request('DELETE', '/tasks/task-1/images/image-1');
  assert.equal(status, 200);
  assert.deepEqual(body, { message: 'Image removed successfully', task: { ...db.taskRow, images: [viewImage] } });
  assert.deepEqual(db.image.findFirst.mock.calls[0].arguments[0].where, { id: 'image-1', taskId: 'task-1' });
  assert.deepEqual(db.image.delete.mock.calls[0].arguments[0], { where: { id: 'image-1' } });
  assert.deepEqual(destroy.mock.calls.map(c => c.arguments[0]), [[publicId]]);
});
test('removing a missing task image is a 404 and touches nothing', async () => {
  setup({ imageFound: false });
  assert.deepEqual(await request('DELETE', '/tasks/task-1/images/image-1'), { status: 404, body: { message: 'Image not found' } });
  assert.equal(db.image.delete.mock.callCount(), 0);
  assert.equal(destroy.mock.callCount(), 0);
});

// ---- expense images ----
const expenseRelations = {
  recorder: { createdById: 'actor', paidById: 'payer' },
  payer: { createdById: 'creator', paidById: 'actor' },
  bystander: { createdById: 'creator', paidById: 'payer' },
};
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  for (const [relation, ownership] of Object.entries(expenseRelations)) {
    const allowed = actor !== 'MEMBER' || ownership.createdById === 'actor' || ownership.paidById === 'actor';
    test(`${actor} as ${relation} adding and removing expense images follows permissions`, async () => {
      setup({ actor, expense: ownership });
      assert.equal((await request('POST', '/expenses/expense-1/images', upload)).status, allowed ? 201 : 403);
      assert.equal(db.image.create.mock.callCount(), allowed ? 1 : 0);
      assert.equal((await request('DELETE', '/expenses/expense-1/images/image-1')).status, allowed ? 200 : 403);
      assert.equal(db.image.delete.mock.callCount(), allowed ? 1 : 0);
    });
  }
}
test('adding an expense image records the upload against the expense and returns the expense with image URLs', async () => {
  setup();
  const { status, body } = await request('POST', '/expenses/expense-1/images', upload);
  assert.equal(status, 201);
  assert.deepEqual(body, { message: 'Image added successfully', expense: { ...db.expenseRow, amount: '99.90', images: [viewImage] } });
  assert.deepEqual(db.image.count.mock.calls[0].arguments[0], { where: { expenseId: 'expense-1' } });
  assert.deepEqual(db.image.create.mock.calls[0].arguments[0].data, { ...upload, expenseId: 'expense-1', householdId: 'home', uploadedById: 'actor' });
  assert.deepEqual(db.expense.findFirst.mock.calls[1].arguments[0].select.images, imagesSelect);
});
test('removing an expense image deletes the row and destroys the file afterwards', async () => {
  setup();
  const { status, body } = await request('DELETE', '/expenses/expense-1/images/image-1');
  assert.equal(status, 200);
  assert.equal(body.message, 'Image removed successfully');
  assert.deepEqual(body.expense.images, [viewImage]);
  assert.deepEqual(db.image.findFirst.mock.calls[0].arguments[0].where, { id: 'image-1', expenseId: 'expense-1' });
  assert.deepEqual(destroy.mock.calls.map(c => c.arguments[0]), [[publicId]]);
});

// ---- deleting a parent ----
test('deleting a task destroys its images after the rows are gone', async () => {
  setup();
  assert.equal((await request('DELETE', '/tasks/task-1')).status, 200);
  assert.deepEqual(db.image.findMany.mock.calls[0].arguments[0].where, { taskId: 'task-1' });
  assert.deepEqual(destroy.mock.calls.map(c => c.arguments[0]), [[publicId, `${publicId}-b`]]);
});
test('deleting an expense destroys its images after the rows are gone', async () => {
  setup();
  assert.equal((await request('DELETE', '/expenses/expense-1')).status, 200);
  assert.deepEqual(db.image.findMany.mock.calls[0].arguments[0].where, { expenseId: 'expense-1' });
  assert.deepEqual(destroy.mock.calls.map(c => c.arguments[0]), [[publicId, `${publicId}-b`]]);
});
test('deleting a parent without images never calls Cloudinary', async () => {
  setup({ parentImages: [] });
  assert.equal((await request('DELETE', '/tasks/task-1')).status, 200);
  assert.equal((await request('DELETE', '/expenses/expense-1')).status, 200);
  assert.equal(destroy.mock.callCount(), 0);
});
test('a Cloudinary failure while destroying is logged and swallowed', async () => {
  mock.restoreAll();
  const logged = mock.method(console, 'error', () => {});
  mock.method(cloudinary.uploader, 'destroy', async (id) => { if (id.endsWith('-b')) throw new Error('cloudinary down'); return { result: 'ok' }; });
  await imageStorage.destroy([publicId, `${publicId}-b`]);
  assert.equal(cloudinary.uploader.destroy.mock.callCount(), 2);
  assert.deepEqual(cloudinary.uploader.destroy.mock.calls[0].arguments, [publicId, { invalidate: true }]);
  assert.equal(logged.mock.callCount(), 1);
});
