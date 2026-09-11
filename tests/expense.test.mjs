import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { once } from 'node:events';
process.env.JWT_SECRET = 'expense-tests-secret';
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
const expenseSelect = { id: true, householdId: true, amount: true, description: true, category: true, createdAt: true, updatedAt: true, paidBy: userSelect, createdBy: userSelect, task: { select: { id: true, title: true, status: true } }, images: { select: imageSelect, orderBy: { createdAt: 'asc' } } };
const expenseOrder = [{ createdAt: 'desc' }, { id: 'asc' }];
const totals = { _sum: { amount: true }, _count: { _all: true } };
const decimal = value => new Prisma.Decimal(value);
// Prisma hands back a Decimal for amount; the API sends it as a two-place string.
const stored = { id: 'expense-1', householdId: 'home', amount: decimal('1250.5'), description: 'Weekly groceries', category: 'GROCERIES', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', paidBy: { id: 'payer', name: 'Payer', email: 'payer@example.com' }, createdBy: { id: 'recorder', name: 'Recorder', email: 'recorder@example.com' }, task: { id: 'task-1', title: 'Buy groceries', status: 'DONE' }, images: [] };
const validBody = { amount: 1250.5 };
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
// createdById / paidById: who recorded and paid the stored expense. found: whether it exists.
function setup({ actor = 'OWNER', createdById = 'recorder', paidById = 'payer', found = true, payerIsMember = true, taskInHousehold = true, total = 1 } = {}) {
  const row = { ...stored, createdById, paidById };
  db = {
    row,
    view: { ...row, amount: '1250.50' },
    householdMember: {
      findUnique: mock.fn(async ({ where }) => {
        const key = where.userId_householdId;
        assert.equal(key.householdId, 'home');
        if (key.userId === 'actor') return actor ? { id: 'actor-membership', role: actor } : null;
        return payerIsMember ? { id: 'payer-membership' } : null;
      }),
    },
    task: {
      findFirst: mock.fn(async ({ where }) => {
        assert.equal(where.householdId, 'home');
        return taskInHousehold ? { id: where.id } : null;
      }),
    },
    image: { findMany: mock.fn(async () => []) },
    user: {
      findMany: mock.fn(async ({ where, select }) => {
        assert.deepEqual(select, userSelect.select);
        return where.id.in.map(id => ({ id, name: `User ${id}`, email: `${id}@example.com` }));
      }),
    },
    expense: {
      findMany: mock.fn(async ({ where, select, orderBy, skip, take }) => {
        assert.equal(where.householdId, 'home');
        assert.deepEqual(select, expenseSelect);
        assert.deepEqual(orderBy, expenseOrder);
        assert.ok(Number.isInteger(skip) && Number.isInteger(take), 'skip and take must be integers');
        return [row];
      }),
      count: mock.fn(async ({ where }) => {
        assert.equal(where.householdId, 'home');
        return total;
      }),
      findFirst: mock.fn(async ({ where }) => {
        assert.deepEqual(where, { id: 'expense-1', householdId: 'home' });
        return found ? row : null;
      }),
      create: mock.fn(async () => row),
      update: mock.fn(async () => row),
      delete: mock.fn(async () => row),
      aggregate: mock.fn(async () => ({ _sum: { amount: decimal('3450') }, _count: { _all: 3 } })),
      groupBy: mock.fn(async ({ by }) => by[0] === 'category'
        ? [{ category: 'GROCERIES', _sum: { amount: decimal('2200.25') }, _count: { _all: 2 } }, { category: 'RENT', _sum: { amount: decimal('1249.75') }, _count: { _all: 1 } }]
        : [{ paidById: 'payer', _sum: { amount: decimal('3450') }, _count: { _all: 3 } }]),
    },
  };
  const transaction = mock.fn(async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn(db);
  });
  prisma.$transaction = transaction;
  return transaction;
}
async function request(method, path, body, auth = `Bearer ${token}`, query = '') {
  const response = await fetch(`${base}/home/expenses${path}${query ? '?' + query : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const endpoints = [['GET', ''], ['GET', '/summary'], ['POST', ''], ['GET', '/expense-1'], ['PATCH', '/expense-1'], ['DELETE', '/expense-1']];
const bodies = { POST: validBody, PATCH: { amount: 5 } };
for (const [method, path] of endpoints) {
  const name = `${method} ${path || '/'}`;
  test(`${name} requires authentication`, async () => {
    const tx = setup();
    assert.equal((await request(method, path, bodies[method], null)).status, 401);
    assert.equal(tx.mock.callCount(), 0);
  });
  test(`${name} denies nonmembers before touching expenses`, async () => {
    setup({ actor: null });
    assert.deepEqual(await request(method, path, bodies[method]), { status: 404, body: { message: 'Household not found or access denied' } });
    for (const fn of [...Object.values(db.expense), db.task.findFirst, db.user.findMany]) assert.equal(fn.mock.callCount(), 0);
  });
}
const expectedSummary = {
  total: '3450.00',
  count: 3,
  byCategory: [{ category: 'GROCERIES', total: '2200.25', count: 2 }, { category: 'RENT', total: '1249.75', count: 1 }],
  byPayer: [{ paidBy: { id: 'payer', name: 'User payer', email: 'payer@example.com' }, total: '3450.00', count: 3 }],
};
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  test(`${actor} can list expenses with safe fields, two-place amounts, and newest-first ordering`, async () => {
    setup({ actor });
    assert.deepEqual(await request('GET', ''), { status: 200, body: { message: 'Expenses fetched successfully', expenses: [db.view], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } } });
  });
  test(`${actor} can view an expense`, async () => {
    setup({ actor });
    assert.deepEqual(await request('GET', '/expense-1'), { status: 200, body: { message: 'Expense fetched successfully', expense: db.view } });
    assert.deepEqual(db.expense.findFirst.mock.calls[0].arguments[0].select, expenseSelect);
  });
  test(`${actor} can create an expense`, async () => {
    setup({ actor });
    assert.deepEqual(await request('POST', '', validBody), { status: 201, body: { message: 'Expense created successfully', expense: db.view } });
  });
  test(`${actor} can read the summary`, async () => {
    setup({ actor });
    assert.deepEqual(await request('GET', '/summary'), { status: 200, body: { message: 'Expense summary fetched successfully', summary: expectedSummary } });
  });
}
test('missing expense returns 404 for view, update, and delete', async () => {
  setup({ found: false });
  assert.deepEqual((await request('GET', '/expense-1')).body, { message: 'Expense not found' });
  assert.equal((await request('PATCH', '/expense-1', { amount: 5 })).status, 404);
  assert.equal((await request('DELETE', '/expense-1')).status, 404);
  assert.equal(db.expense.update.mock.callCount(), 0);
  assert.equal(db.expense.delete.mock.callCount(), 0);
});
const listQuery = query => request('GET', '', undefined, undefined, query);
const summaryQuery = query => request('GET', '/summary', undefined, undefined, query);
const CATEGORY_MESSAGE = 'Category must be one of GROCERIES, UTILITIES, RENT, MAINTENANCE, TRANSPORT, HEALTH, ENTERTAINMENT, OTHER';
test('list and summary validate query parameters before accessing the database', async () => {
  const tx = setup();
  const invalid = ['category=groceries', 'category=', 'category=RENT&category=OTHER', 'paidById=', 'taskId=', 'from=', 'from=yesterday', 'to=soon', 'from=2026-09-10&to=2026-09-01'];
  for (const query of invalid) {
    assert.equal((await listQuery(query)).status, 400, query);
    assert.equal((await summaryQuery(query)).status, 400, query);
  }
  for (const query of ['page=0', 'page=1.5', 'page=100001', 'limit=0', 'limit=101', 'limit=1&limit=2']) assert.equal((await listQuery(query)).status, 400, query);
  assert.deepEqual((await listQuery('category=groceries')).body, { message: CATEGORY_MESSAGE });
  assert.deepEqual((await listQuery('paidById=')).body, { message: 'Payer user ID is required' });
  assert.deepEqual((await listQuery('from=yesterday')).body, { message: 'From must be an ISO 8601 date string' });
  assert.deepEqual((await listQuery('from=2026-09-10&to=2026-09-01')).body, { message: 'From must not be after to' });
  assert.deepEqual((await listQuery('limit=101')).body, { message: 'Limit must be an integer between 1 and 100' });
  assert.equal(tx.mock.callCount(), 0);
});
test('list defaults to the first page of 20 with no filter', async () => {
  setup();
  const { status, body } = await listQuery('');
  assert.equal(status, 200);
  const args = db.expense.findMany.mock.calls[0].arguments[0];
  assert.deepEqual([args.where, args.skip, args.take], [{ householdId: 'home' }, 0, 20]);
  assert.deepEqual(db.expense.count.mock.calls[0].arguments[0], { where: { householdId: 'home' } });
  assert.deepEqual(body.pagination, { page: 1, limit: 20, total: 1, totalPages: 1 });
});
test('list applies every filter and the page to both the rows and the total', async () => {
  setup({ total: 12 });
  const { body } = await listQuery('category=RENT&paidById=payer&taskId=task-1&from=2026-09-01&to=2026-09-30T23:59:59.999Z&page=3&limit=5');
  const where = { householdId: 'home', category: 'RENT', paidById: 'payer', taskId: 'task-1', createdAt: { gte: new Date('2026-09-01'), lte: new Date('2026-09-30T23:59:59.999Z') } };
  const args = db.expense.findMany.mock.calls[0].arguments[0];
  assert.deepEqual([args.where, args.skip, args.take], [where, 10, 5]);
  assert.deepEqual(db.expense.count.mock.calls[0].arguments[0], { where });
  assert.deepEqual(body.pagination, { page: 3, limit: 5, total: 12, totalPages: 3 });
});
test('list accepts an open-ended date range', async () => {
  setup();
  await listQuery('from=2026-09-01');
  assert.deepEqual(db.expense.findMany.mock.calls[0].arguments[0].where, { householdId: 'home', createdAt: { gte: new Date('2026-09-01') } });
  await listQuery('to=2026-09-30');
  assert.deepEqual(db.expense.findMany.mock.calls[1].arguments[0].where, { householdId: 'home', createdAt: { lte: new Date('2026-09-30') } });
});
test('list reports zero pages when nothing matches', async () => {
  setup({ total: 0 });
  db.expense.findMany = mock.fn(async () => []);
  assert.deepEqual((await listQuery('category=RENT')).body, { message: 'Expenses fetched successfully', expenses: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
});
test('summary sums in the database with the same filter, orders groups by total, and names each payer', async () => {
  setup();
  const { body } = await summaryQuery('category=GROCERIES&paidById=payer&page=abc');
  const where = { householdId: 'home', category: 'GROCERIES', paidById: 'payer' };
  assert.deepEqual(body.summary, expectedSummary);
  assert.deepEqual(db.expense.aggregate.mock.calls[0].arguments[0], { where, ...totals });
  assert.deepEqual(db.expense.groupBy.mock.calls.map(c => c.arguments[0]), [
    { by: ['category'], where, ...totals, orderBy: { _sum: { amount: 'desc' } } },
    { by: ['paidById'], where, ...totals, orderBy: { _sum: { amount: 'desc' } } },
  ]);
  assert.deepEqual(db.user.findMany.mock.calls[0].arguments[0].where, { id: { in: ['payer'] } });
});
test('summary of nothing is zero without looking up payers', async () => {
  setup();
  db.expense.aggregate = mock.fn(async () => ({ _sum: { amount: null }, _count: { _all: 0 } }));
  db.expense.groupBy = mock.fn(async () => []);
  assert.deepEqual((await summaryQuery('')).body.summary, { total: '0.00', count: 0, byCategory: [], byPayer: [] });
  assert.equal(db.user.findMany.mock.callCount(), 0);
});
const AMOUNT_MESSAGE = 'Amount must be a positive number below 10000000000 with at most 2 decimal places';
test('create validates the body before accessing the database', async () => {
  const tx = setup();
  const invalid = [undefined, {}, { amount: '' }, { amount: 'abc' }, { amount: -1 }, { amount: 0 }, { amount: '0.00' }, { amount: 1.005 }, { amount: '12.345' },
    { amount: 12345678901 }, { amount: '1e3' }, { amount: null }, { amount: true }, { amount: ' 12 ' }, { amount: '.5' }, { amount: '5.' }, { amount: [5] },
    { amount: 1, category: 'groceries' }, { amount: 1, category: null }, { amount: 1, description: 7 },
    { amount: 1, paidById: '' }, { amount: 1, paidById: null }, { amount: 1, paidById: 3 }, { amount: 1, taskId: '' }];
  for (const body of invalid) assert.equal((await request('POST', '', body)).status, 400, JSON.stringify(body));
  assert.equal(tx.mock.callCount(), 0);
});
test('create explains each invalid field', async () => {
  setup();
  const cases = [
    [{}, 'Amount is required'],
    [{ amount: 'abc' }, AMOUNT_MESSAGE],
    [{ amount: 12345678901 }, AMOUNT_MESSAGE],
    [{ amount: 1, category: 'groceries' }, CATEGORY_MESSAGE],
    [{ amount: 1, description: 7 }, 'Description must be a string or null'],
    [{ amount: 1, paidById: null }, 'Payer user ID is required'],
    [{ amount: 1, taskId: '' }, 'Task ID is required'],
  ];
  for (const [body, message] of cases) assert.deepEqual((await request('POST', '', body)).body, { message });
});
test('create defaults the payer to the requester and takes the household from the URL and the recorder from the token', async () => {
  setup();
  assert.equal((await request('POST', '', { amount: '1250', householdId: 'other', createdById: 'someone', id: 'forged', createdAt: 'yesterday' })).status, 201);
  const args = db.expense.create.mock.calls[0].arguments[0];
  assert.deepEqual(args.data, { amount: '1250.00', paidById: 'actor', householdId: 'home', createdById: 'actor' });
  assert.deepEqual(args.select, expenseSelect);
  assert.equal(db.householdMember.findUnique.mock.callCount(), 1);
  assert.equal(db.task.findFirst.mock.callCount(), 0);
});
test('create normalizes amounts to two places without floating point', async () => {
  setup();
  const cases = [['1250', '1250.00'], [12.5, '12.50'], ['0012.30', '12.30'], [0.5, '0.50'], ['9999999999.99', '9999999999.99'], [7, '7.00'], ['0.01', '0.01']];
  for (const [amount] of cases) {
    assert.equal((await request('POST', '', { amount })).status, 201, String(amount));
  }
  assert.deepEqual(db.expense.create.mock.calls.map(c => c.arguments[0].data.amount), cases.map(([, expected]) => expected));
});
test('create stores every optional field and checks the payer is a member and the task is in the household', async () => {
  setup();
  const body = { amount: 99.9, description: '  Plumber  ', category: 'MAINTENANCE', paidById: 'payer', taskId: 'task-1' };
  assert.equal((await request('POST', '', body)).status, 201);
  assert.deepEqual(db.expense.create.mock.calls[0].arguments[0].data, { amount: '99.90', description: 'Plumber', category: 'MAINTENANCE', paidById: 'payer', taskId: 'task-1', householdId: 'home', createdById: 'actor' });
  assert.deepEqual(db.householdMember.findUnique.mock.calls.map(c => c.arguments[0].where.userId_householdId.userId), ['actor', 'payer']);
  assert.deepEqual(db.task.findFirst.mock.calls[0].arguments[0], { where: { id: 'task-1', householdId: 'home' }, select: { id: true } });
});
test('create does not look the requester up twice when they name themselves as payer', async () => {
  setup();
  assert.equal((await request('POST', '', { amount: 1, paidById: 'actor' })).status, 201);
  assert.equal(db.householdMember.findUnique.mock.callCount(), 1);
  assert.deepEqual(db.expense.create.mock.calls[0].arguments[0].data.paidById, 'actor');
});
test('create rejects a payer outside the household', async () => {
  setup({ payerIsMember: false });
  assert.deepEqual(await request('POST', '', { amount: 1, paidById: 'stranger' }), { status: 400, body: { message: 'Payer must be a member of this household' } });
  assert.equal(db.expense.create.mock.callCount(), 0);
});
test('create rejects a task from another household', async () => {
  setup({ taskInHousehold: false });
  assert.deepEqual(await request('POST', '', { amount: 1, taskId: 'foreign-task' }), { status: 400, body: { message: 'Task must belong to this household' } });
  assert.equal(db.expense.create.mock.callCount(), 0);
});
test('create treats a blank description and a null task as cleared', async () => {
  setup();
  assert.equal((await request('POST', '', { amount: 1, description: '   ', taskId: null })).status, 201);
  assert.deepEqual(db.expense.create.mock.calls[0].arguments[0].data, { amount: '1.00', description: null, taskId: null, paidById: 'actor', householdId: 'home', createdById: 'actor' });
  assert.equal(db.task.findFirst.mock.callCount(), 0);
});
// Who the requester is relative to the stored expense.
const relations = {
  recorder: { createdById: 'actor', paidById: 'payer' },
  payer: { createdById: 'recorder', paidById: 'actor' },
  'recorder and payer': { createdById: 'actor', paidById: 'actor' },
  bystander: { createdById: 'recorder', paidById: 'payer' },
};
for (const actor of ['OWNER', 'ADMIN', 'MEMBER']) {
  for (const [relation, ownership] of Object.entries(relations)) {
    const manages = actor !== 'MEMBER' || ownership.createdById === 'actor' || ownership.paidById === 'actor';
    test(`${actor} as ${relation} updating follows permissions`, async () => {
      setup({ actor, ...ownership });
      const attempts = [{ amount: 5 }, { category: 'RENT', description: 'September' }, { taskId: null }];
      for (const body of attempts) assert.equal((await request('PATCH', '/expense-1', body)).status, manages ? 200 : 403, JSON.stringify(body));
      assert.equal(db.expense.update.mock.callCount(), manages ? attempts.length : 0);
    });
    test(`${actor} as ${relation} deleting follows permissions`, async () => {
      setup({ actor, ...ownership });
      assert.equal((await request('DELETE', '/expense-1')).status, manages ? 200 : 403);
      assert.equal(db.expense.delete.mock.callCount(), manages ? 1 : 0);
    });
  }
}
test('refused updates and deletes explain why', async () => {
  setup({ actor: 'MEMBER', createdById: 'recorder', paidById: 'payer' });
  assert.deepEqual((await request('PATCH', '/expense-1', { amount: 5 })).body, { message: 'You can only manage expenses you recorded or paid' });
  assert.deepEqual((await request('DELETE', '/expense-1')).body, { message: 'You can only manage expenses you recorded or paid' });
});
test('update validates the body before accessing the database', async () => {
  const tx = setup();
  for (const body of [undefined, {}, { unknown: 1 }, { amount: '' }, { amount: -5 }, { amount: '1.234' }, { category: 'rent' }, { description: [] }, { paidById: '' }, { paidById: null }, { taskId: '' }]) {
    assert.equal((await request('PATCH', '/expense-1', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await request('PATCH', '/expense-1', { unknown: 1 })).body, { message: 'Provide at least one of: amount, description, category, paidById, taskId' });
  assert.equal(tx.mock.callCount(), 0);
});
test('update sends only the supplied fields, clears with null, and ignores ownership in the body', async () => {
  setup();
  const body = { amount: '80', description: null, taskId: null, householdId: 'other', createdById: 'someone' };
  assert.deepEqual(await request('PATCH', '/expense-1', body), { status: 200, body: { message: 'Expense updated successfully', expense: db.view } });
  assert.deepEqual(db.expense.update.mock.calls[0].arguments[0], { where: { id: 'expense-1', householdId: 'home' }, data: { amount: '80.00', description: null, taskId: null }, select: expenseSelect });
  assert.equal(db.householdMember.findUnique.mock.callCount(), 1);
  assert.equal(db.task.findFirst.mock.callCount(), 0);
});
test('update checks a new payer is a member and a new task is in the household', async () => {
  setup();
  assert.equal((await request('PATCH', '/expense-1', { paidById: 'payer', taskId: 'task-2' })).status, 200);
  assert.deepEqual(db.expense.update.mock.calls[0].arguments[0].data, { paidById: 'payer', taskId: 'task-2' });
  assert.deepEqual(db.householdMember.findUnique.mock.calls.map(c => c.arguments[0].where.userId_householdId.userId), ['actor', 'payer']);
  assert.deepEqual(db.task.findFirst.mock.calls[0].arguments[0].where, { id: 'task-2', householdId: 'home' });
  setup({ payerIsMember: false });
  assert.deepEqual(await request('PATCH', '/expense-1', { paidById: 'stranger' }), { status: 400, body: { message: 'Payer must be a member of this household' } });
  assert.equal(db.expense.update.mock.callCount(), 0);
  setup({ taskInHousehold: false });
  assert.deepEqual(await request('PATCH', '/expense-1', { taskId: 'foreign-task' }), { status: 400, body: { message: 'Task must belong to this household' } });
  assert.equal(db.expense.update.mock.callCount(), 0);
});
test('update does not look the requester up twice when they take over as payer', async () => {
  setup();
  assert.equal((await request('PATCH', '/expense-1', { paidById: 'actor' })).status, 200);
  assert.equal(db.householdMember.findUnique.mock.callCount(), 1);
});
test('delete scopes the row to the household', async () => {
  setup();
  assert.deepEqual(await request('DELETE', '/expense-1'), { status: 200, body: { message: 'Expense deleted successfully' } });
  assert.deepEqual(db.expense.delete.mock.calls[0].arguments[0], { where: { id: 'expense-1', householdId: 'home' } });
});
const prismaError = code => new Prisma.PrismaClientKnownRequestError('private details', { code, clientVersion: '7.10.0' });
test('serialization retry rechecks membership after the actor is removed', async () => {
  setup();
  db.expense.create = mock.fn(async () => {
    db.householdMember.findUnique = mock.fn(async () => null);
    throw prismaError('P2034');
  });
  assert.equal((await request('POST', '', validBody)).status, 404);
  assert.equal(db.expense.create.mock.callCount(), 1);
});
test('serialization retries are bounded', async () => {
  setup();
  db.expense.create = mock.fn(async () => { throw prismaError('P2034'); });
  assert.deepEqual(await request('POST', '', validBody), { status: 409, body: { message: 'Expenses changed concurrently; please retry' } });
  assert.equal(db.expense.create.mock.callCount(), 3);
});
test('rows vanishing mid-write become 404', async () => {
  setup();
  db.expense.update = mock.fn(async () => { throw prismaError('P2025'); });
  assert.deepEqual(await request('PATCH', '/expense-1', { amount: 5 }), { status: 404, body: { message: 'Household, member, task, or expense no longer exists' } });
  db.expense.create = mock.fn(async () => { throw prismaError('P2003'); });
  assert.equal((await request('POST', '', { amount: 1, taskId: 'task-1' })).status, 404);
});
test('unexpected errors do not expose database details', async () => {
  setup();
  mock.method(console, 'error', () => {});
  db.expense.findMany = mock.fn(async () => { throw new Error('private details'); });
  assert.deepEqual(await request('GET', ''), { status: 500, body: { message: 'Expense operation failed' } });
});
