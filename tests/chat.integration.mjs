// Uses an isolated, random schema; never resets or migrates application tables.
// Run explicitly: node --import tsx --test tests/chat.integration.mjs
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { io as connectSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';

test('chat REST, privacy, ordering, sockets, outbox and Expo receipts on PostgreSQL', { timeout: 120_000 }, async t => {
  const schema = `chat_test_${randomUUID().replaceAll('-', '')}`;
  process.env.DATABASE_SCHEMA = schema;
  process.env.JWT_SECRET = 'chat-integration-test-secret';
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  let prisma, server, io;
  const sockets = [];
  const originalFetch = globalThis.fetch;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migrations = (await readdir('prisma/migrations')).filter(name => /^\d/.test(name)).sort();
    for (const name of migrations) await client.query((await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8')).replace(/^\uFEFF/, ''));
    ({ default: prisma } = await import('../src/lib/prisma.ts'));
    const { default: app } = await import('../src/app.ts');
    const chat = await import('../src/services/chat.service.ts');
    const devices = await import('../src/services/device-token.service.ts');
    const delivery = await import('../src/services/chat-delivery.service.ts');
    const { attachRealtime } = await import('../src/lib/realtime.ts');
    const { chatEvents } = await import('../src/lib/chat-events.ts');
    const { signToken } = await import('../src/lib/jwt.ts');
    const { removeHouseholdMember } = await import('../src/services/household-member.service.ts');
    await prisma.user.createMany({ data: ['alice', 'bob', 'owner', 'outsider'].map(id => ({ id, name: id, email: `${id}@chat.test` })) });
    for (const id of ['home', 'other']) {
      await prisma.household.create({ data: { id, name: id, createdById: 'owner', members: { create: [
        { userId: 'owner', role: 'OWNER' }, { userId: 'alice' }, { userId: 'bob' },
      ] } } });
    }
    server = createServer(app);
    io = attachRealtime(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = id => signToken({ userId: id, email: `${id}@chat.test` });
    async function request(user, method, path, body) {
      const response = await originalFetch(`${base}/api${path}`, {
        method, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }
    async function socket(user, customToken) {
      const s = connectSocket(base, { transports: ['websocket'], auth: { token: customToken ?? token(user) }, reconnection: false, forceNew: true });
      sockets.push(s);
      await Promise.race([once(s, 'connect'), once(s, 'connect_error').then(([e]) => { throw e; })]);
      return s;
    }
    let direct, group, other, first;
    const remove = (user, messageIds, scope) => request(user, 'POST', `/conversations/${direct}/messages/delete`, { messageIds, scope });
    await t.test('authentication, membership and immutable direct pair', async () => {
      assert.equal((await request(null, 'GET', '/households/home/conversations')).status, 401);
      assert.equal((await request('outsider', 'GET', '/households/home/conversations')).status, 404);
      assert.equal((await request('alice', 'POST', '/households/home/conversations/direct', { recipientId: 'alice' })).status, 400);
      assert.equal((await request('alice', 'POST', '/households/home/conversations/direct', { recipientId: 'outsider' })).status, 404);
      const pair = await Promise.all([
        chat.ensureDirectConversation('home', 'alice', 'bob'), chat.ensureDirectConversation('home', 'bob', 'alice'),
      ]);
      assert.equal(pair[0].id, pair[1].id);
      direct = pair[0].id;
      other = (await chat.ensureDirectConversation('other', 'alice', 'bob')).id;
      assert.notEqual(other, direct);
      const list = await request('alice', 'GET', '/households/home/conversations');
      assert.equal(list.status, 200);
      group = list.body.conversations.find(c => c.type === 'HOUSEHOLD').id;
      assert.equal((await request('owner', 'GET', `/conversations/${direct}/messages`)).status, 404);
      assert.equal((await request('owner', 'GET', `/conversations/${direct}`)).status, 404);
      assert.equal((await request('owner', 'PATCH', `/conversations/${direct}/read`, { sequence: 0 })).status, 404);
      assert.equal((await request('owner', 'PATCH', `/conversations/${direct}/preferences`, { muted: true })).status, 404);
      assert.equal((await request('owner', 'GET', '/households/home/conversations')).body.conversations.length, 1);
    });
    await t.test('idempotent concurrent send, spoof protection and ordered recovery', async () => {
      const payload = { clientMessageId: 'first-message', text: 'Hello Bob', senderId: 'owner' };
      const [a, b] = await Promise.all([
        request('alice', 'POST', `/conversations/${direct}/messages`, payload),
        request('alice', 'POST', `/conversations/${direct}/messages`, payload),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 201]);
      assert.equal(a.body.message.id, b.body.message.id);
      assert.equal(a.body.message.senderId, 'alice');
      first = a.body.message;
      assert.equal(await prisma.chatDelivery.count({ where: { messageId: first.id } }), 2);
      assert.equal((await request('alice', 'POST', `/conversations/${direct}/messages`, { ...payload, text: 'changed' })).status, 409);
      const sent = await Promise.all([1, 2, 3].map(n => chat.sendMessage(direct, 'alice', `concurrent-${n}`, `Message ${n}`)));
      assert.deepEqual(sent.map(x => x.message.sequence).sort(), [2, 3, 4]);
      const latest = await request('bob', 'GET', `/conversations/${direct}/messages?limit=2`);
      assert.deepEqual(latest.body.messages.map(m => m.sequence), [3, 4]);
      assert.equal(latest.body.nextBefore, 3);
      const previous = await request('bob', 'GET', `/conversations/${direct}/messages?before=3&limit=2`);
      assert.deepEqual(previous.body.messages.map(m => m.sequence), [1, 2]);
      const recovery = await request('bob', 'GET', `/conversations/${direct}/messages?after=1&limit=2`);
      assert.deepEqual(recovery.body.messages.map(m => m.sequence), [2, 3]);
      assert.equal(recovery.body.nextAfter, 3);
      assert.equal((await request('bob', 'GET', `/conversations/${direct}/messages?before=3&after=0`)).status, 400);
      for (const text of ['', '   ', 'x'.repeat(4001)]) assert.equal((await request('alice', 'POST', `/conversations/${direct}/messages`, { clientMessageId: 'invalid-message', text })).status, 400);
      assert.equal((await request('alice', 'POST', `/conversations/${direct}/messages`, { clientMessageId: 'x', text: 'Hi' })).status, 400);
    });
    await t.test('monotonic read state, grouped notifications and mute', async () => {
      assert.equal((await chat.getConversation(direct, 'bob')).unreadCount, 4);
      assert.equal(await prisma.notification.count({ where: { userId: 'bob', entityId: direct } }), 1);
      await Promise.all([chat.markConversationRead(direct, 'bob', 4), chat.markConversationRead(direct, 'bob', 2)]);
      assert.equal((await chat.getConversation(direct, 'bob')).lastReadSequence, 4);
      assert.equal((await chat.getConversation(direct, 'bob')).unreadCount, 0);
      // Reading everything removes the inbox alert instead of leaving a stale read row behind.
      assert.equal(await prisma.notification.findUnique({ where: { id: chat.chatNotificationId(direct, 'bob') } }), null);
      assert.equal((await request('bob', 'PATCH', `/conversations/${direct}/read`, { sequence: 999 })).status, 400);
      const registered = await request('bob', 'POST', '/devices', { token: 'ExpoPushToken[bob-device]', platform: 'android', userId: 'alice' });
      assert.equal(registered.status, 200);
      assert.equal((await prisma.deviceToken.findUnique({ where: { id: registered.body.device.id } })).userId, 'bob');
      await chat.setConversationMuted(direct, 'bob', true);
      const muted = await chat.sendMessage(direct, 'alice', 'muted-message', 'Muted hello');
      assert.equal(await prisma.chatDelivery.count({ where: { messageId: muted.message.id, kind: 'PUSH' } }), 0);
      assert.equal((await chat.getConversation(direct, 'bob')).unreadCount, 1);
      await chat.setConversationMuted(direct, 'bob', false);
    });
    const bobSocketEvents = [], ownerSocketEvents = [];
    await t.test('authenticated sockets deliver only to authorized users, including token expiry', async () => {
      await assert.rejects(socket('alice', 'invalid'), /Invalid or expired/);
      const bobSocket = await socket('bob');
      const ownerSocket = await socket('owner');
      bobSocket.on('chat:message', event => bobSocketEvents.push(event));
      ownerSocket.on('chat:message', event => ownerSocketEvents.push(event));
      ownerSocket.emit('join', direct); // No client-selected room subscription exists.
      const received = once(bobSocket, 'chat:message');
      let job;
      while ((job = await delivery.claimDelivery(false))) await delivery.processDelivery(job);
      await received;
      assert.ok(bobSocketEvents.some(e => e.message.id === first.id));
      assert.equal(ownerSocketEvents.length, 0);
      const expiring = await socket('alice', jwt.sign({ userId: 'alice', email: 'alice@chat.test' }, process.env.JWT_SECRET, { expiresIn: 2 }));
      await once(expiring, 'disconnect');
    });
    await t.test('push remains disabled, claims are exclusive, receipts and invalid-token cleanup', async () => {
      const pushMessage = await chat.sendMessage(direct, 'alice', 'push-message', 'Push me');
      // The alert removed by the earlier read comes back, unread, with the next message.
      assert.equal((await prisma.notification.findUnique({ where: { id: chat.chatNotificationId(direct, 'bob') } })).isRead, false);
      await prisma.chatDelivery.updateMany({ where: { messageId: pushMessage.message.id }, data: { availableAt: new Date(0) } });
      let job;
      while ((job = await delivery.claimDelivery(false))) { assert.equal(job.kind, 'LIVE'); await delivery.processDelivery(job); }
      const claims = await Promise.all([delivery.claimDelivery(true), delivery.claimDelivery(true)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const push = claims.find(Boolean);
      assert.equal(push.kind, 'PUSH');
      let requests = [];
      globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket-test' } }));
      };
      await delivery.processDelivery(push);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.to, 'ExpoPushToken[bob-device]');
      assert.equal(requests[0].body.data.conversationId, direct);
      assert.equal(requests[0].body.title, 'alice');
      assert.equal(requests[0].body.body, 'Push me');
      await prisma.chatDelivery.update({ where: { id: push.id }, data: { availableAt: new Date(0) } });
      globalThis.fetch = async () => new Response(JSON.stringify({ data: { 'ticket-test': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }));
      await delivery.processDelivery(await delivery.claimDelivery(true));
      assert.equal(await prisma.deviceToken.count({ where: { userId: 'bob' } }), 0);
      globalThis.fetch = originalFetch;
    });
    await t.test('read-before-push suppression, retries and device ownership transfer', async () => {
      const device = await devices.registerDevice('bob', 'ExpoPushToken[retry-device]', 'android');
      const sent = await chat.sendMessage(direct, 'alice', 'read-before-push', 'Read before push');
      await chat.markConversationRead(direct, 'bob', sent.message.sequence);
      let requests = 0;
      globalThis.fetch = async () => { requests++; throw new Error('temporary'); };
      let push = await prisma.chatDelivery.findFirst({ where: { messageId: sent.message.id, kind: 'PUSH' } });
      await delivery.processDelivery(push);
      assert.equal(requests, 0);
      assert.ok((await prisma.chatDelivery.findUnique({ where: { id: push.id } })).completedAt);
      const retry = await chat.sendMessage(direct, 'alice', 'retry-push-message', 'Retry');
      push = await prisma.chatDelivery.findFirst({ where: { messageId: retry.message.id, kind: 'PUSH' } });
      await delivery.processDelivery({ ...push, attempts: 1 });
      const pending = await prisma.chatDelivery.findUnique({ where: { id: push.id } });
      assert.equal(pending.failedAt, null);
      assert.equal(pending.lastError, 'NetworkError');
      assert.ok(pending.availableAt.getTime() > Date.now());
      const moved = await devices.registerDevice('alice', 'ExpoPushToken[retry-device]', 'android');
      assert.notEqual(moved.id, device.id);
      assert.equal(await prisma.chatDelivery.count({ where: { deviceTokenId: device.id } }), 0);
      assert.equal((await request('bob', 'DELETE', `/devices/${moved.id}`)).status, 204);
      assert.ok(await prisma.deviceToken.findUnique({ where: { id: moved.id } }));
      globalThis.fetch = originalFetch;
    });
    await t.test('delete for me is private and delete for everyone is a timed tombstone', async () => {
      await devices.registerDevice('bob', 'ExpoPushToken[delete-device]', 'android');
      const bobSocket = await socket('bob');
      const aliceSocket = await socket('alice');

      const privateDelete = await chat.sendMessage(direct, 'alice', 'delete-for-me-message', 'Bob can hide this');
      const bobHiddenEvent = once(bobSocket, 'chat:messages-deleted');
      const hidden = await remove('bob', [privateDelete.message.id], 'me');
      assert.equal(hidden.status, 200);
      assert.equal(hidden.body.deletion.scope, 'me');
      assert.deepEqual(hidden.body.deletion.messages, []);
      assert.deepEqual((await bobHiddenEvent)[0].messageIds, [privateDelete.message.id]);
      assert.ok(!(await chat.getMessages(direct, 'bob', { limit: 100 })).messages.some(message => message.id === privateDelete.message.id));
      assert.ok((await chat.getMessages(direct, 'alice', { limit: 100 })).messages.some(message => message.id === privateDelete.message.id));
      const privateState = await request('bob', 'POST', `/conversations/${direct}/messages/reconcile`, { messageIds: [privateDelete.message.id] });
      assert.deepEqual(privateState.body.hiddenMessageIds, [privateDelete.message.id]);
      assert.deepEqual(privateState.body.deletedMessages, []);
      assert.equal(await prisma.chatDelivery.count({ where: {
        messageId: privateDelete.message.id, userId: 'bob', completedAt: null,
      } }), 0);
      assert.equal((await remove('bob', [privateDelete.message.id], 'me')).status, 200);

      const universal = await chat.sendMessage(direct, 'alice', 'delete-everyone-message', 'Remove this everywhere');
      const bobDeletedEvent = once(bobSocket, 'chat:messages-deleted');
      const aliceDeletedEvent = once(aliceSocket, 'chat:messages-deleted');
      const removed = await remove('alice', [universal.message.id], 'everyone');
      assert.equal(removed.status, 200);
      assert.equal(removed.body.deletion.messages[0].text, '');
      assert.ok(removed.body.deletion.messages[0].deletedAt);
      const [bobEvent] = await bobDeletedEvent;
      const [aliceEvent] = await aliceDeletedEvent;
      assert.equal(bobEvent.messages[0].id, universal.message.id);
      assert.equal(aliceEvent.messages[0].id, universal.message.id);
      assert.ok(bobEvent.conversation);
      const bobCopy = (await chat.getMessages(direct, 'bob', { limit: 100 })).messages.find(message => message.id === universal.message.id);
      assert.equal(bobCopy.text, '');
      assert.ok(bobCopy.deletedAt);
      const reconciled = await request('bob', 'POST', `/conversations/${direct}/messages/reconcile`, {
        messageIds: [privateDelete.message.id, universal.message.id],
      });
      assert.deepEqual(reconciled.body.hiddenMessageIds, [privateDelete.message.id]);
      assert.equal(reconciled.body.deletedMessages[0].id, universal.message.id);
      assert.equal(await prisma.chatDelivery.count({ where: {
        messageId: universal.message.id, kind: 'PUSH', completedAt: null,
      } }), 0);
      assert.equal((await remove('alice', [universal.message.id], 'everyone')).status, 200);
      assert.equal((await remove('bob', [universal.message.id], 'everyone')).status, 403);

      const expired = await chat.sendMessage(direct, 'alice', 'expired-delete-message', 'Too old for everyone');
      await prisma.message.update({ where: { id: expired.message.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
      assert.equal((await remove('alice', [expired.message.id], 'everyone')).status, 409);
      assert.equal((await remove('alice', [expired.message.id], 'me')).status, 200);
      assert.equal((await remove('alice', [expired.message.id], 'invalid')).status, 400);
      assert.equal((await remove('owner', [expired.message.id], 'me')).status, 404);
      // The single-message route is gone: one endpoint serves one message or many.
      const oldRoute = await originalFetch(`${base}/api/conversations/${direct}/messages/${expired.message.id}?scope=me`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token('alice')}` },
      });
      assert.equal(oldRoute.status, 404);
      assert.equal((await request('owner', 'POST', `/conversations/${direct}/messages/reconcile`, { messageIds: [expired.message.id] })).status, 404);
      assert.equal((await request('alice', 'POST', `/conversations/${direct}/messages/reconcile`, { messageIds: [] })).status, 400);
    });
    await t.test('a batch of messages is deleted together or not at all', async () => {
      const send = async (user, n) => (await chat.sendMessage(direct, user, `batch-message-${user}-${n}`, `Batch ${n}`)).message;
      const one = await send('alice', 1), two = await send('alice', 2), three = await send('alice', 3);
      const fromBob = await send('bob', 1);
      const visible = async user => (await chat.getMessages(direct, user, { limit: 100 })).messages;

      // One unknown ID rejects the whole batch, and nothing is hidden.
      assert.equal((await remove('bob', [one.id, 'no-such-message'], 'me')).status, 404);
      assert.ok((await visible('bob')).some(message => message.id === one.id));
      // Someone else's message blocks "everyone" for the whole batch, so Alice's own stays intact.
      assert.equal((await remove('alice', [one.id, fromBob.id], 'everyone')).status, 403);
      assert.equal((await visible('alice')).find(message => message.id === one.id).deletedAt, null);
      // The list must hold 1 to 50 IDs.
      assert.equal((await remove('bob', Array.from({ length: 51 }, (_, i) => `id-${i}`), 'me')).status, 400);
      assert.equal((await remove('bob', [], 'me')).status, 400);
      assert.equal((await remove('bob', 'not-a-list', 'me')).status, 400);

      const bobSocket = await socket('bob');
      const events = [];
      bobSocket.on('chat:messages-deleted', event => events.push(event));
      const firstEvent = once(bobSocket, 'chat:messages-deleted');
      const hidden = await remove('bob', [one.id, two.id, one.id], 'me');
      assert.equal(hidden.status, 200);
      assert.deepEqual([...hidden.body.deletion.messageIds].sort(), [one.id, two.id].sort());
      const bobSees = (await visible('bob')).map(message => message.id);
      assert.ok(!bobSees.includes(one.id) && !bobSees.includes(two.id) && bobSees.includes(three.id));
      const aliceSees = (await visible('alice')).map(message => message.id);
      assert.ok(aliceSees.includes(one.id) && aliceSees.includes(two.id));
      // The whole batch travels in one event, not one per message.
      await firstEvent;
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(events.length, 1);
      assert.equal(events[0].messageIds.length, 2);

      const removed = await remove('alice', [three.id, two.id], 'everyone');
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body.deletion.messages.map(message => message.id), [two.id, three.id]);
      assert.ok(removed.body.deletion.messages.every(message => message.text === '' && message.deletedAt));
    });
    await t.test('clear chat empties only the caller\'s history', async () => {
      const before = await chat.sendMessage(direct, 'alice', 'before-clear', 'Bob will clear this');
      assert.ok((await chat.getConversation(direct, 'bob')).unreadCount > 0);
      assert.ok(await prisma.notification.findUnique({ where: { id: chat.chatNotificationId(direct, 'bob') } }));
      const aliceBefore = (await chat.getMessages(direct, 'alice', { limit: 100 })).messages.length;
      const bobSocket = await socket('bob');
      const aliceSocket = await socket('alice');
      const aliceEvents = [];
      aliceSocket.on('chat:cleared', event => aliceEvents.push(event));
      const clearedEvent = once(bobSocket, 'chat:cleared');

      const cleared = await request('bob', 'POST', `/conversations/${direct}/clear`);
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.clearedSequence, before.message.sequence);
      assert.equal(cleared.body.conversation.latestMessage, null);
      assert.equal(cleared.body.conversation.unreadCount, 0);
      assert.equal((await clearedEvent)[0].conversationId, direct);

      // Bob's history is empty on every page, his inbox alert is gone and queued jobs are cancelled.
      const bobPage = await chat.getMessages(direct, 'bob', { limit: 100 });
      assert.deepEqual(bobPage.messages, []);
      assert.equal(bobPage.hasMore, false);
      assert.deepEqual((await chat.getMessages(direct, 'bob', { before: before.message.sequence + 1, limit: 100 })).messages, []);
      assert.equal(await prisma.notification.findUnique({ where: { id: chat.chatNotificationId(direct, 'bob') } }), null);
      assert.equal(await prisma.chatDelivery.count({ where: { messageId: before.message.id, userId: 'bob', completedAt: null } }), 0);
      // A device that was offline learns to drop the cleared message when it reconciles.
      const reconciled = await request('bob', 'POST', `/conversations/${direct}/messages/reconcile`, { messageIds: [before.message.id] });
      assert.deepEqual(reconciled.body.hiddenMessageIds, [before.message.id]);

      // Alice keeps everything and hears nothing about it.
      assert.equal((await chat.getMessages(direct, 'alice', { limit: 100 })).messages.length, aliceBefore);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(aliceEvents.length, 0);

      // A message sent afterwards shows for both.
      const after = await chat.sendMessage(direct, 'alice', 'after-clear', 'Fresh start');
      assert.deepEqual((await chat.getMessages(direct, 'bob', { limit: 100 })).messages.map(message => message.id), [after.message.id]);
      assert.equal((await chat.getConversation(direct, 'bob')).unreadCount, 1);
      assert.equal((await chat.getMessages(direct, 'alice', { limit: 100 })).messages.length, aliceBefore + 1);
      assert.equal((await request('owner', 'POST', `/conversations/${direct}/clear`)).status, 404);
    });
    await t.test('outbox rolls back with message and database enforces unique positions', async () => {
      const original = prisma.$transaction;
      const count = await prisma.message.count();
      prisma.$transaction = (fn, options) => original.call(prisma, tx => fn(new Proxy(tx, { get(target, property) {
        if (property === 'chatDelivery') return { createMany: async () => { throw new Error('queue failed'); } };
        return Reflect.get(target, property);
      } })), options);
      try { await assert.rejects(chat.sendMessage(direct, 'alice', 'rollback-message', 'Must roll back'), /queue failed/); }
      finally { prisma.$transaction = original; }
      assert.equal(await prisma.message.count(), count);
      await assert.rejects(prisma.message.create({ data: { conversationId: direct, senderId: 'alice', clientMessageId: 'duplicate-pos', sequence: 1, text: 'duplicate' } }), { code: 'P2002' });
    });
    await t.test('household messages reach current members and new members can read history', async () => {
      const sent = await chat.sendMessage(group, 'owner', 'household-message', 'Shared household message');
      const delivered = [];
      const listener = (user, event, payload) => { if (event === 'chat:message' && payload.message.id === sent.message.id) delivered.push(user); };
      chatEvents.on('delivery', listener);
      try {
        for (const job of await prisma.chatDelivery.findMany({ where: { messageId: sent.message.id, kind: 'LIVE' } })) await delivery.processDelivery(job);
      } finally { chatEvents.off('delivery', listener); }
      assert.deepEqual(delivered.sort(), ['alice', 'bob', 'owner']);
      assert.equal((await request('outsider', 'GET', `/conversations/${group}/messages`)).status, 404);
      await prisma.householdMember.create({ data: { householdId: 'home', userId: 'outsider' } });
      assert.equal((await chat.getMessages(group, 'outsider', { limit: 30 })).messages[0].id, sent.message.id);
      assert.equal((await request('outsider', 'GET', `/conversations/${direct}/messages`)).status, 404);
    });
    await t.test('removing a member blocks history, sends, and pending live/push delivery', async () => {
      await devices.registerDevice('bob', 'ExpoPushToken[removed-member]', 'android');
      const sent = await chat.sendMessage(direct, 'alice', 'before-removal', 'Private after removal');
      await removeHouseholdMember('home', 'owner', 'bob');
      for (const path of [`/conversations/${direct}`, `/conversations/${direct}/messages`, `/conversations/${group}/messages`]) {
        assert.equal((await request('bob', 'GET', path)).status, 404);
      }
      assert.equal((await request('bob', 'POST', `/conversations/${direct}/messages`, { clientMessageId: 'after-removal', text: 'No access' })).status, 404);
      assert.equal((await request('alice', 'POST', `/conversations/${direct}/messages`, { clientMessageId: 'other-removed', text: 'No recipient' })).status, 409);
      const delivered = [];
      const listener = (user, event, payload) => delivered.push({ user, event, payload });
      chatEvents.on('delivery', listener);
      let pushRequests = 0;
      globalThis.fetch = async () => { pushRequests++; throw new Error('Must not send'); };
      try {
        const jobs = await prisma.chatDelivery.findMany({ where: { messageId: sent.message.id, userId: 'bob' } });
        assert.ok(jobs.some(job => job.kind === 'PUSH'));
        for (const job of jobs) await delivery.processDelivery(job);
      } finally { chatEvents.off('delivery', listener); globalThis.fetch = originalFetch; }
      assert.equal(delivered.length, 0);
      assert.equal(pushRequests, 0);
      assert.equal((await chat.getConversation(direct, 'alice')).canSend, false);
      assert.equal((await chat.getMessages(other, 'bob', { limit: 30 })).messages.length, 0);
    });
    await t.test('database rate limit rejects new messages but allows idempotent retries', async () => {
      const current = await prisma.conversation.findUnique({ where: { id: group } });
      await prisma.message.createMany({ data: Array.from({ length: 60 }, (_, i) => ({
        conversationId: group, senderId: 'owner', clientMessageId: `rate-fixture-${i}`,
        sequence: current.sequence + i + 1, text: 'Fixture message',
      })) });
      await prisma.conversation.update({ where: { id: group }, data: { sequence: current.sequence + 60 } });
      assert.equal((await request('owner', 'POST', `/conversations/${group}/messages`, { clientMessageId: 'rate-limited', text: 'Too fast' })).status, 429);
      assert.equal((await request('owner', 'POST', `/conversations/${group}/messages`, { clientMessageId: 'rate-fixture-0', text: 'Fixture message' })).status, 200);
    });
  } finally {
    globalThis.fetch = originalFetch;
    sockets.forEach(socket => socket.disconnect());
    if (io) await new Promise(resolve => io.close(resolve));
    else if (server) await new Promise(resolve => server.close(resolve));
    await prisma?.$disconnect();
    // Generated identifier validated before this exact test-only schema removal.
    assert.match(schema, /^chat_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
