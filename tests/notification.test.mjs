import assert from 'node:assert/strict';
import { after, afterEach, mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { default: prisma } = await import('../src/lib/prisma.ts');
const { Prisma } = await import('../generated/prisma/client.ts');
const { createNotification } = await import('../src/services/notification.service.ts');

const input = {
  userId: 'recipient-id',
  type: 'TASK_ASSIGNED',
  title: 'New task assigned to you',
  message: 'Praveen assigned you a task: Buy groceries',
};
const saved = { id: 'notification-id', ...input, isRead: false, createdAt: new Date() };

const originalCreate = prisma.notification.create;
afterEach(() => { prisma.notification.create = originalCreate; mock.restoreAll(); });
after(async () => prisma.$disconnect());

test('creates a notification using the shared Prisma client by default', async () => {
  const create = mock.fn(async () => saved);
  prisma.notification.create = create;
  assert.deepEqual(await createNotification(input), saved);
  assert.deepEqual(create.mock.calls[0].arguments, [{ data: input }]);
});

test('uses the supplied transaction and leaves defaults to the database', async () => {
  const outsideTransaction = mock.fn(async () => {
    throw new Error('Must use the caller transaction');
  });
  prisma.notification.create = outsideTransaction;
  const create = mock.fn(async () => saved);
  const tx = { notification: { create } };

  assert.deepEqual(await createNotification({ ...input, title: '  New task assigned to you  ', isRead: true }, tx), saved);
  assert.deepEqual(create.mock.calls[0].arguments, [{ data: input }]);
  assert.equal(outsideTransaction.mock.callCount(), 0);
});

test('saves the optional navigation target and rejects blank target IDs', async () => {
  const create = mock.fn(async () => saved);
  const tx = { notification: { create } };
  const target = { householdId: 'home', entityId: 'task-1' };

  await createNotification({ ...input, ...target }, tx);
  assert.deepEqual(create.mock.calls[0].arguments, [{ data: { ...input, ...target } }]);

  for (const field of Object.keys(target)) {
    for (const value of [null, '', '   ', 123]) {
      await assert.rejects(createNotification({ ...input, ...target, [field]: value }, tx), {
        name: 'AppError', statusCode: 400,
      });
    }
  }
  assert.equal(create.mock.callCount(), 1);
});

test('rejects missing, blank, and non-string fields before writing', async () => {
  const create = mock.fn();
  const tx = { notification: { create } };

  for (const field of Object.keys(input)) {
    for (const value of [undefined, null, '', '   ', 123, {}]) {
      await assert.rejects(createNotification({ ...input, [field]: value }, tx), {
        name: 'AppError', statusCode: 400,
      });
    }
  }
  assert.equal(create.mock.callCount(), 0);
});

test('reports an unknown recipient as a not-found error', async () => {
  const tx = { notification: { create: async () => {
    throw new Prisma.PrismaClientKnownRequestError('Foreign key failed', {
      code: 'P2003', clientVersion: '7.10.0',
    });
  } } };
  await assert.rejects(createNotification(input, tx), {
    name: 'AppError', statusCode: 404, message: 'Notification recipient not found',
  });
});

test('propagates failures so the caller can roll back or retry its transaction', async () => {
  for (const failure of [
    new Error('Database unavailable'),
    new Prisma.PrismaClientKnownRequestError('Serialization conflict', {
      code: 'P2034', clientVersion: '7.10.0',
    }),
  ]) {
    const tx = { notification: { create: async () => { throw failure; } } };
    await assert.rejects(createNotification(input, tx), (error) => error === failure);
  }
});


test('rejects unknown notification types before writing', async () => {
  const create = mock.fn();
  await assert.rejects(createNotification({ ...input, type: 'UNKNOWN' }, { notification: { create } }), {
    name: 'AppError', statusCode: 400, message: 'Invalid notification type',
  });
  assert.equal(create.mock.callCount(), 0);
});
