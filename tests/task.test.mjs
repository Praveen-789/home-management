import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'task-tests-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: app } = await import('../src/app.ts');
const { default: prisma } = await import('../src/lib/prisma.ts');
const { signToken } = await import('../src/lib/jwt.ts');
const { Prisma } = await import('../generated/prisma/client.ts');
const originalTransaction = prisma.$transaction;
let server, base, db;
const token = signToken({ userId: 'actor', email: 'actor@example.com' });
const userSelect = { select: { id: true, name: true, email: true } };
const imageSelect = { id: true, publicId: true, width: true, height: true, bytes: true, format: true, createdAt: true, uploadedBy: userSelect };
const taskSelect = { id: true, householdId: true, title: true, description: true, status: true, priority: true, dueDate: true, createdAt: true, updatedAt: true, createdBy: userSelect, assignedTo: userSelect, images: { select: imageSelect, orderBy: { createdAt: 'asc' } } };
const taskOrder = [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }];
const task = { id: 'task-1', householdId: 'home', title: 'Buy groceries', description: null, status: 'TODO', priority: 'MEDIUM', dueDate: null, createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', createdBy: { id: 'creator', name: 'Creator', email: 'creator@example.com' }, assignedTo: null, images: [] };
const validBody = { title: 'Buy groceries' };
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
// actor: the requester's role, or null when they are not a member.
// createdById / assignedToId: who owns the stored task. found: whether the task exists.
function setup({ actor = 'OWNER', createdById = 'creator', assignedToId = 'assignee', found = true, assigneeIsMember = true, total = 1 } = {}) {
  const row = { ...task, createdById, assignedToId };
  db = {
    row,
    householdMember: {
      findUnique: mock.fn(async ({ where }) => {
        const key = where.userId_householdId;
        assert.equal(key.householdId, 'home');
        if (key.userId === 'actor') return actor ? { id: 'actor-membership', role: actor } : null;
        return assigneeIsMember ? { id: 'assignee-membership' } : null;
      }),
    },
    image: { findMany: mock.fn(async () => []) },
    task: {
      findMany: mock.fn(async ({ where, select, orderBy, skip, take }) => {
        assert.equal(where.householdId, 'home');
        assert.deepEqual(select, taskSelect);
        assert.deepEqual(orderBy, taskOrder);
        assert.ok(Number.isInteger(skip) && Number.isInteger(take), 'skip and take must be integers');
        return [row];
      }),
      count: mock.fn(async ({ where }) => {
        assert.equal(where.householdId, 'home');
        return total;
      }),
      findFirst: mock.fn(async ({ where }) => {
        assert.deepEqual(where, { id: 'task-1', householdId: 'home' });
        return found ? row : null;
      }),
      create: mock.fn(async () => row),
      update: mock.fn(async () => row),
      delete: mock.fn(async () => row),
    },
  };
  const transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  prisma.$transaction = transaction;
  return transaction;
}
async function request(method, taskId, body, auth = `Bearer ${token}`, query = '') {
  const response = await fetch(`${base}/home/tasks${taskId ? '/' + taskId : ''}${query ? '?' + query : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const endpoints = [['GET', null], ['POST', null], ['GET', 'task-1'], ['PATCH', 'task-1'], ['DELETE', 'task-1']];
const bodies = { POST: validBody, PATCH: { status: 'DONE' } };
for (const [method, taskId] of endpoints) {
  const name = `${method} ${taskId ? '/:taskId' : '/'}`;
  test(`${name} requires authentication`, async () => {
    const tx = setup();
    assert.equal((await request(method, taskId, bodies[method], null)).status, 401);
    assert.equal(tx.mock.callCount(), 0);
  });
  test(`${name} denies nonmembers before touching tasks`, async () => {
    setup({ actor: null });
    assert.deepEqual(await request(method, taskId, bodies[method]), { status: 404, body: { message: 'Household not found or access denied' } });
    for (const fn of Object.values(db.task)) assert.equal(fn.mock.callCount(), 0);
  });
}
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  test(`${actor} can list tasks with safe fields and due-date ordering`, async () => {
    setup({ actor });
    assert.deepEqual(await request('GET', null), { status: 200, body: { message: 'Tasks fetched successfully', tasks: [db.row], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } } });
  });
  test(`${actor} can view a task`, async () => {
    setup({ actor });
    assert.deepEqual(await request('GET', 'task-1'), { status: 200, body: { message: 'Task fetched successfully', task: db.row } });
    assert.deepEqual(db.task.findFirst.mock.calls[0].arguments[0].select, taskSelect);
  });
  test(`${actor} can create a task`, async () => {
    setup({ actor });
    assert.deepEqual(await request('POST', null, validBody), { status: 201, body: { message: 'Task created successfully', task: db.row } });
  });
}
test('missing task returns 404 for view, update, and delete', async () => {
  setup({ found: false });
  assert.deepEqual((await request('GET', 'task-1')).body, { message: 'Task not found' });
  assert.equal((await request('PATCH', 'task-1', { status: 'DONE' })).status, 404);
  assert.equal((await request('DELETE', 'task-1')).status, 404);
  assert.equal(db.task.update.mock.callCount(), 0);
  assert.equal(db.task.delete.mock.callCount(), 0);
});
const listQuery = query => request('GET', null, undefined, undefined, query);
test('list validates query parameters before accessing the database', async () => {
  const tx = setup();
  for (const query of ['status=todo', 'status=', 'status=TODO&status=DONE', 'page=0', 'page=-1', 'page=abc', 'page=1.5', 'page=100001', 'limit=0', 'limit=101', 'limit=ten', 'limit=1&limit=2']) {
    assert.equal((await listQuery(query)).status, 400, query);
  }
  assert.deepEqual((await listQuery('status=todo')).body, { message: 'Status must be one of TODO, IN_PROGRESS, DONE' });
  assert.deepEqual((await listQuery('page=0')).body, { message: 'Page must be an integer between 1 and 100000' });
  assert.deepEqual((await listQuery('limit=101')).body, { message: 'Limit must be an integer between 1 and 100' });
  assert.equal(tx.mock.callCount(), 0);
});
test('list defaults to the first page of 20 with no filter', async () => {
  setup();
  const { status, body } = await listQuery('');
  assert.equal(status, 200);
  const args = db.task.findMany.mock.calls[0].arguments[0];
  assert.deepEqual([args.where, args.skip, args.take], [{ householdId: 'home' }, 0, 20]);
  assert.deepEqual(db.task.count.mock.calls[0].arguments[0], { where: { householdId: 'home' } });
  assert.deepEqual(body.pagination, { page: 1, limit: 20, total: 1, totalPages: 1 });
});
test('list applies the status filter and page to both the rows and the total', async () => {
  setup({ total: 12 });
  const { body } = await listQuery('status=DONE&page=3&limit=5');
  const args = db.task.findMany.mock.calls[0].arguments[0];
  assert.deepEqual([args.where, args.skip, args.take], [{ householdId: 'home', status: 'DONE' }, 10, 5]);
  assert.deepEqual(db.task.count.mock.calls[0].arguments[0], { where: { householdId: 'home', status: 'DONE' } });
  assert.deepEqual(body.pagination, { page: 3, limit: 5, total: 12, totalPages: 3 });
});
test('list reports zero pages when nothing matches', async () => {
  setup({ total: 0 });
  db.task.findMany = mock.fn(async () => []);
  assert.deepEqual((await listQuery('status=DONE')).body, { message: 'Tasks fetched successfully', tasks: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
});
test('create validates the body before accessing the database', async () => {
  const tx = setup();
  const invalid = [undefined, {}, { title: '' }, { title: '   ' }, { title: 5 }, { title: null },
    { title: 'x', status: 'todo' }, { title: 'x', status: null }, { title: 'x', priority: 'URGENT' },
    { title: 'x', dueDate: 'tomorrow' }, { title: 'x', dueDate: 1757289600000 }, { title: 'x', dueDate: {} },
    { title: 'x', description: 7 }, { title: 'x', assignedToId: '' }, { title: 'x', assignedToId: 3 }];
  for (const body of invalid) assert.equal((await request('POST', null, body)).status, 400, JSON.stringify(body));
  assert.equal(tx.mock.callCount(), 0);
});
test('create explains each invalid field', async () => {
  setup();
  const cases = [
    [{}, 'Title is required'],
    [{ title: 'x', status: 'todo' }, 'Status must be one of TODO, IN_PROGRESS, DONE'],
    [{ title: 'x', priority: 'URGENT' }, 'Priority must be one of LOW, MEDIUM, HIGH'],
    [{ title: 'x', dueDate: 'tomorrow' }, 'Due date must be an ISO 8601 date string or null'],
    [{ title: 'x', description: 7 }, 'Description must be a string or null'],
    [{ title: 'x', assignedToId: '' }, 'Assignee user ID is required'],
  ];
  for (const [body, message] of cases) assert.deepEqual((await request('POST', null, body)).body, { message });
});
test('create takes the household from the URL and the creator from the token', async () => {
  setup();
  assert.equal((await request('POST', null, { title: ' Buy groceries ', householdId: 'other', createdById: 'someone', id: 'forged', createdAt: 'yesterday' })).status, 201);
  const args = db.task.create.mock.calls[0].arguments[0];
  assert.deepEqual(args.data, { title: 'Buy groceries', householdId: 'home', createdById: 'actor' });
  assert.deepEqual(args.select, taskSelect);
  assert.equal(db.householdMember.findUnique.mock.callCount(), 1);
});
test('create stores every optional field and checks the assignee is a member', async () => {
  setup();
  const body = { title: 'Clean kitchen', description: '  Wipe counters  ', status: 'IN_PROGRESS', priority: 'HIGH', dueDate: '2026-09-10T18:00:00.000Z', assignedToId: 'assignee' };
  assert.equal((await request('POST', null, body)).status, 201);
  assert.deepEqual(db.task.create.mock.calls[0].arguments[0].data, { ...body, description: 'Wipe counters', dueDate: new Date('2026-09-10T18:00:00.000Z'), householdId: 'home', createdById: 'actor' });
  assert.deepEqual(db.householdMember.findUnique.mock.calls.map(c => c.arguments[0].where.userId_householdId.userId), ['actor', 'assignee']);
});
test('create rejects an assignee outside the household', async () => {
  setup({ assigneeIsMember: false });
  assert.deepEqual(await request('POST', null, { title: 'x', assignedToId: 'stranger' }), { status: 400, body: { message: 'Assignee must be a member of this household' } });
  assert.equal(db.task.create.mock.callCount(), 0);
});
test('create treats a blank description and null fields as cleared', async () => {
  setup();
  assert.equal((await request('POST', null, { title: 'x', description: '   ', dueDate: null, assignedToId: null })).status, 201);
  assert.deepEqual(db.task.create.mock.calls[0].arguments[0].data, { title: 'x', description: null, dueDate: null, assignedToId: null, householdId: 'home', createdById: 'actor' });
});
// Who the requester is relative to the stored task.
const relations = {
  creator: { createdById: 'actor', assignedToId: 'assignee' },
  assignee: { createdById: 'creator', assignedToId: 'actor' },
  'creator and assignee': { createdById: 'actor', assignedToId: 'actor' },
  bystander: { createdById: 'creator', assignedToId: 'assignee' },
  'bystander on unassigned task': { createdById: 'creator', assignedToId: null },
};
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  for (const [relation, ownership] of Object.entries(relations)) {
    const manages = actor !== 'MEMBER' || ownership.createdById === 'actor';
    const assigned = ownership.assignedToId === 'actor';
    test(`${actor} as ${relation} updating status follows permissions`, async () => {
      setup({ actor, ...ownership });
      const allowed = manages || assigned;
      assert.equal((await request('PATCH', 'task-1', { status: 'DONE' })).status, allowed ? 200 : 403);
      assert.equal(db.task.update.mock.callCount(), allowed ? 1 : 0);
    });
    test(`${actor} as ${relation} updating other fields follows permissions`, async () => {
      setup({ actor, ...ownership });
      const attempts = [{ title: 'Renamed' }, { status: 'DONE', priority: 'LOW' }, { assignedToId: null }];
      for (const body of attempts) assert.equal((await request('PATCH', 'task-1', body)).status, manages ? 200 : 403, JSON.stringify(body));
      assert.equal(db.task.update.mock.callCount(), manages ? attempts.length : 0);
    });
    test(`${actor} as ${relation} deleting follows permissions`, async () => {
      setup({ actor, ...ownership });
      assert.equal((await request('DELETE', 'task-1')).status, manages ? 200 : 403);
      assert.equal(db.task.delete.mock.callCount(), manages ? 1 : 0);
    });
  }
}
test('refused updates and deletes explain why', async () => {
  setup({ actor: 'MEMBER', createdById: 'creator', assignedToId: 'actor' });
  assert.deepEqual((await request('PATCH', 'task-1', { title: 'x' })).body, { message: 'Assignees can only update the task status' });
  assert.deepEqual((await request('DELETE', 'task-1')).body, { message: 'You can only manage tasks you created' });
  setup({ actor: 'MEMBER', createdById: 'creator', assignedToId: 'someone-else' });
  assert.deepEqual((await request('PATCH', 'task-1', { status: 'DONE' })).body, { message: 'You can only update tasks you created or are assigned to' });
});
test('update validates the body before accessing the database', async () => {
  const tx = setup();
  for (const body of [undefined, {}, { unknown: 1 }, { title: '' }, { title: 9 }, { status: 'done' }, { priority: 'urgent' }, { dueDate: 'soon' }, { description: [] }, { assignedToId: '' }]) {
    assert.equal((await request('PATCH', 'task-1', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await request('PATCH', 'task-1', { unknown: 1 })).body, { message: 'Provide at least one of: title, description, status, priority, dueDate, assignedToId' });
  assert.equal(tx.mock.callCount(), 0);
});
test('update sends only the supplied fields, clears with null, and ignores ownership in the body', async () => {
  setup();
  const body = { title: ' Pay electricity ', description: null, dueDate: null, assignedToId: null, householdId: 'other', createdById: 'someone' };
  assert.deepEqual(await request('PATCH', 'task-1', body), { status: 200, body: { message: 'Task updated successfully', task: db.row } });
  assert.deepEqual(db.task.update.mock.calls[0].arguments[0], { where: { id: 'task-1', householdId: 'home' }, data: { title: 'Pay electricity', description: null, dueDate: null, assignedToId: null }, select: taskSelect });
  assert.equal(db.householdMember.findUnique.mock.callCount(), 1);
});
test('update checks a new assignee is a member', async () => {
  setup();
  assert.equal((await request('PATCH', 'task-1', { assignedToId: 'assignee', dueDate: '2026-09-12' })).status, 200);
  assert.deepEqual(db.task.update.mock.calls[0].arguments[0].data, { assignedToId: 'assignee', dueDate: new Date('2026-09-12') });
  setup({ assigneeIsMember: false });
  assert.deepEqual(await request('PATCH', 'task-1', { assignedToId: 'stranger' }), { status: 400, body: { message: 'Assignee must be a member of this household' } });
  assert.equal(db.task.update.mock.callCount(), 0);
});
test('delete scopes the row to the household', async () => {
  setup();
  assert.deepEqual(await request('DELETE', 'task-1'), { status: 200, body: { message: 'Task deleted successfully' } });
  assert.deepEqual(db.task.delete.mock.calls[0].arguments[0], { where: { id: 'task-1', householdId: 'home' } });
});
const prismaError = code => new Prisma.PrismaClientKnownRequestError('private details', { code, clientVersion: '7.10.0' });
test('serialization retry rechecks membership after the actor is removed', async () => {
  setup();
  db.task.create = mock.fn(async () => {
    db.householdMember.findUnique = mock.fn(async () => null);
    throw prismaError('P2034');
  });
  assert.equal((await request('POST', null, validBody)).status, 404);
  assert.equal(db.task.create.mock.callCount(), 1);
});
test('serialization retries are bounded', async () => {
  setup();
  db.task.create = mock.fn(async () => { throw prismaError('P2034'); });
  assert.deepEqual(await request('POST', null, validBody), { status: 409, body: { message: 'Tasks changed concurrently; please retry' } });
  assert.equal(db.task.create.mock.callCount(), 3);
});
test('rows vanishing mid-write become 404', async () => {
  setup();
  db.task.update = mock.fn(async () => { throw prismaError('P2025'); });
  assert.deepEqual(await request('PATCH', 'task-1', { status: 'DONE' }), { status: 404, body: { message: 'Household, member, or task no longer exists' } });
  db.task.create = mock.fn(async () => { throw prismaError('P2003'); });
  assert.equal((await request('POST', null, { title: 'x', assignedToId: 'assignee' })).status, 404);
});
test('unexpected errors do not expose database details', async () => {
  setup();
  mock.method(console, 'error', () => {});
  db.task.findMany = mock.fn(async () => { throw new Error('private details'); });
  assert.deepEqual(await request('GET', null), { status: 500, body: { message: 'Task operation failed' } });
});
