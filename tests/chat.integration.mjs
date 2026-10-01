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
    await t.test('presence supports multiple devices, background activity and household privacy', async () => {
      const { setTimeout: delay } = await import('node:timers/promises');
      const { drainPresence } = await import('../src/services/presence.service.ts');
      const bobPhone = await socket('bob');
      const outsiderPhone = await socket('outsider');
      const received = [], leaked = [];
      bobPhone.on('chat:presence', event => { if (event.userId === 'alice') received.push(event); });
      outsiderPhone.on('chat:presence', event => { if (event.userId === 'alice') leaked.push(event); });
      const alicePhone = await socket('alice');
      const aliceWeb = await socket('alice');
      await drainPresence();
      await delay(100);
      assert.equal(received.filter(e => e.isOnline).length, 1);
      alicePhone.emit('chat:activity', { active: false });
      await delay(100);
      assert.equal((await chat.getConversation(direct, 'bob')).participants.find(p => p.id === 'alice').isOnline, true);
      aliceWeb.disconnect();
      await delay(5300);
      await drainPresence();
      await delay(100);
      const peer = (await chat.getConversation(direct, 'bob')).participants.find(p => p.id === 'alice');
      assert.equal(peer.isOnline, false);
      assert.ok(peer.lastSeenAt);
      assert.ok((await prisma.user.findUnique({ where: { id: 'alice' } })).lastSeenAt);
      assert.equal(received.filter(e => !e.isOnline).length, 1);
      alicePhone.emit('chat:activity', { active: true });
      await delay(100);
      await drainPresence();
      assert.equal((await chat.getConversation(direct, 'bob')).participants.find(p => p.id === 'alice').isOnline, true);
      assert.deepEqual(leaked, []);
      alicePhone.disconnect(); bobPhone.disconnect(); outsiderPhone.disconnect();
      await delay(5300);
      await drainPresence();
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
    await t.test('typing reaches the others in the chat, nobody outside it, and not too often', async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const heard = { alice: [], bob: [], owner: [], outsider: [] };
      const phones = { alice: await socket('alice'), bob: await socket('bob'), owner: await socket('owner'), outsider: await socket('outsider') };
      for (const [user, phone] of Object.entries(phones)) phone.on('chat:typing', event => heard[user].push(event));
      const counts = () => Object.values(heard).map(events => events.length);
      const forget = () => Object.values(heard).forEach(events => { events.length = 0; });

      // ---- a private chat: the other person hears it; the typist's devices and the household do not ----
      const bobHears = once(phones.bob, 'chat:typing');
      phones.alice.emit('chat:typing', { conversationId: direct });
      assert.deepEqual((await bobHears)[0], { conversationId: direct, userId: 'alice', name: 'alice' });
      // A second report within a second is dropped before it reaches the database.
      phones.alice.emit('chat:typing', { conversationId: direct });
      await pause(200);
      assert.deepEqual(counts(), [0, 1, 0, 0]);

      // ---- the household chat: every other member hears it ----
      forget();
      const ownerHears = once(phones.owner, 'chat:typing');
      phones.bob.emit('chat:typing', { conversationId: group });
      assert.equal((await ownerHears)[0].userId, 'bob');
      await pause(200);
      assert.deepEqual(counts(), [1, 0, 1, 0]);

      // ---- someone outside the chat, or a malformed report, is ignored and the socket stays up ----
      forget();
      await pause(1000);
      phones.owner.emit('chat:typing', { conversationId: direct });
      phones.outsider.emit('chat:typing', { conversationId: group });
      phones.alice.emit('chat:typing', 'not a report');
      phones.bob.emit('chat:typing', { conversationId: 42 });
      await pause(300);
      assert.deepEqual(counts(), [0, 0, 0, 0]);
      assert.ok(Object.values(phones).every(phone => phone.connected));
      Object.values(phones).forEach(phone => phone.disconnect());
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
      // An Android push is data-only, so the app can draw it with Reply and Mark as read buttons.
      assert.equal(requests[0].body.title, undefined);
      assert.equal(requests[0].body.data.previewTitle, 'alice');
      assert.equal(requests[0].body.data.previewBody, 'Push me');
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
    await t.test('photo messages: signed per conversation, optional captions, removed with delete for everyone', async () => {
      const { imageStorage } = await import('../src/lib/cloudinary.ts');
      const destroyed = [];
      const originalDestroy = imageStorage.destroy;
      // Nothing may reach the real Cloudinary account from a test.
      imageStorage.destroy = async publicIds => { destroyed.push(...publicIds); };
      const originalFetchForPush = globalThis.fetch;
      try {
        const upload = async (user, conversation) => request(user, 'POST', `/conversations/${conversation}/uploads`);
        const photo = publicId => ({ publicId, width: 1200, height: 900, bytes: 345678, format: 'JPG' });
        const send = (user, clientMessageId, body) => request(user, 'POST', `/conversations/${direct}/messages`, { clientMessageId, ...body });

        // ---- a ticket is signed only for someone in the conversation, into its own folder ----
        const ticket = await upload('alice', direct);
        assert.equal(ticket.status, 201);
        const folder = `homehub/households/home/chat/${direct}`;
        assert.match(ticket.body.upload.publicId, new RegExp(`^${folder}/[0-9a-f-]{36}$`));
        assert.equal(ticket.body.upload.fields.asset_folder, folder);
        assert.equal((await upload('owner', direct)).status, 404); // not in this private chat
        assert.equal((await upload(null, direct)).status, 401);
        assert.equal((await upload('alice', 'no-such-conversation')).status, 404);

        // ---- a photo with no caption, retried safely ----
        const sent = await send('alice', 'photo-message', { images: [photo(ticket.body.upload.publicId)] });
        assert.equal(sent.status, 201);
        const [image] = sent.body.message.images;
        assert.equal(sent.body.message.text, '');
        assert.equal(sent.body.message.images.length, 1);
        assert.equal(image.publicId, undefined); // URLs travel instead of the public ID
        assert.ok(image.url.endsWith(`/f_auto,q_auto/${ticket.body.upload.publicId}`));
        assert.ok(image.thumbnailUrl.includes('/c_fill,g_auto,w_400,h_400,'));
        assert.deepEqual([image.width, image.height, image.bytes, image.format], [1200, 900, 345678, 'jpg']);
        const retry = await send('alice', 'photo-message', { images: [photo(ticket.body.upload.publicId)] });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.message.id, sent.body.message.id);
        // The same client ID with a different message, or the same photo in a new message, is refused.
        assert.equal((await send('alice', 'photo-message', { text: 'Now with a caption', images: [photo(ticket.body.upload.publicId)] })).status, 409);
        assert.equal((await send('alice', 'photo-message', { text: 'Only text' })).status, 409);
        assert.equal((await send('alice', 'photo-again', { images: [photo(ticket.body.upload.publicId)] })).status, 409);

        // ---- the other person sees it in history, the chat list, the live event and the alert ----
        const bobPage = await request('bob', 'GET', `/conversations/${direct}/messages?limit=1`);
        assert.equal(bobPage.body.messages[0].images[0].url, image.url);
        const summary = (await request('bob', 'GET', `/conversations/${direct}`)).body.conversation;
        assert.equal(summary.latestMessage.images[0].thumbnailUrl, image.thumbnailUrl);
        const live = [];
        const listener = (user, event, payload) => { if (event === 'chat:message') live.push({ user, payload }); };
        chatEvents.on('delivery', listener);
        try {
          for (const job of await prisma.chatDelivery.findMany({ where: { messageId: sent.body.message.id, kind: 'LIVE' } })) await delivery.processDelivery(job);
        } finally { chatEvents.off('delivery', listener); }
        assert.deepEqual(live.map(entry => entry.user).sort(), ['alice', 'bob']);
        assert.ok(live.every(entry => entry.payload.message.images[0].url === image.url && entry.payload.message.images[0].publicId === undefined));
        const pushes = [];
        globalThis.fetch = async (_url, options) => {
          pushes.push(JSON.parse(options.body));
          return new Response(JSON.stringify({ data: { status: 'ok', id: 'photo-ticket' } }));
        };
        const push = await prisma.chatDelivery.findFirst({ where: { messageId: sent.body.message.id, kind: 'PUSH' } });
        await delivery.processDelivery(push);
        assert.equal(pushes[0].data.previewBody, '📷 Photo');

        // ---- only a photo signed for this chat, one per message, with sensible details ----
        const second = (await upload('alice', direct)).body.upload.publicId;
        const third = (await upload('alice', direct)).body.upload.publicId;
        const elsewhere = (await upload('alice', group)).body.upload.publicId;
        assert.equal((await send('alice', 'other-chat-photo', { images: [photo(elsewhere)] })).status, 400);
        assert.equal((await send('alice', 'task-photo', { images: [photo(`homehub/households/home/${randomUUID()}`)] })).status, 400);
        assert.equal((await send('alice', 'two-photos', { images: [photo(second), photo(third)] })).status, 400);
        assert.equal((await send('alice', 'gif-photo', { images: [{ ...photo(second), format: 'gif' }] })).status, 400);
        assert.equal((await send('alice', 'zero-width-photo', { images: [{ ...photo(second), width: 0 }] })).status, 400);
        assert.equal((await send('alice', 'not-a-list', { images: photo(second) })).status, 400);
        assert.equal((await send('alice', 'numeric-text', { text: 5, images: [photo(second)] })).status, 400);
        assert.equal((await send('alice', 'nothing-sent', { text: '   ', images: [] })).status, 400);
        assert.equal((await send('alice', 'long-caption', { text: 'x'.repeat(4001), images: [photo(second)] })).status, 400);
        assert.equal(await prisma.image.count({ where: { publicId: { in: [second, third, elsewhere] } } }), 0);
        // The database still refuses whitespace for text, whatever the service does.
        await assert.rejects(prisma.message.create({ data: { conversationId: direct, senderId: 'alice', clientMessageId: 'blank-text', sequence: 999999, text: '   ' } }));

        // ---- a caption is trimmed, and push shows it behind a camera ----
        const captioned = await send('alice', 'captioned-photo', { text: '  Leak under the sink ', images: [photo(second)] });
        assert.equal(captioned.status, 201);
        assert.equal(captioned.body.message.text, 'Leak under the sink');
        await delivery.processDelivery(await prisma.chatDelivery.findFirst({ where: { messageId: captioned.body.message.id, kind: 'PUSH' } }));
        assert.equal(pushes[1].data.previewBody, '📷 Leak under the sink');

        // ---- delete for me keeps the photo for everyone else; delete for everyone removes it ----
        assert.equal((await remove('bob', [sent.body.message.id], 'me')).status, 200);
        assert.ok(await prisma.image.findUnique({ where: { publicId: ticket.body.upload.publicId } }));
        assert.equal((await chat.getMessages(direct, 'alice', { limit: 100 })).messages.find(m => m.id === sent.body.message.id).images.length, 1);
        const removed = await remove('alice', [captioned.body.message.id], 'everyone');
        assert.equal(removed.status, 200);
        assert.deepEqual(removed.body.deletion.messages[0].images, []);
        assert.equal(removed.body.deletion.messages[0].text, '');
        assert.equal(await prisma.image.count({ where: { messageId: captioned.body.message.id } }), 0);
        assert.deepEqual(destroyed, [second]);
        const reconciled = await request('bob', 'POST', `/conversations/${direct}/messages/reconcile`, { messageIds: [captioned.body.message.id] });
        assert.deepEqual(reconciled.body.deletedMessages[0].images, []);
      } finally {
        imageStorage.destroy = originalDestroy;
        globalThis.fetch = originalFetchForPush;
      }
    });
    await t.test('editing: sender only, within 15 minutes, heard by everyone who still sees it, caught up by reconcile', async () => {
      const edit = (user, messageId, text, conversation = direct) =>
        request(user, 'PATCH', `/conversations/${conversation}/messages/${messageId}`, text === undefined ? {} : { text });
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const heard = { alice: [], bob: [], owner: [] };
      const phones = { alice: await socket('alice'), bob: await socket('bob'), owner: await socket('owner') };
      for (const [user, phone] of Object.entries(phones)) phone.on('chat:message-edited', event => heard[user].push(event));

      // ---- the sender changes the text; both people in the chat hear it, nobody else does ----
      const { message } = await chat.sendMessage(direct, 'alice', 'edit-me', 'Dinner at 7');
      const bobHears = once(phones.bob, 'chat:message-edited');
      const edited = await edit('alice', message.id, '  Dinner at 8 ');
      assert.equal(edited.status, 200);
      assert.equal(edited.body.message.text, 'Dinner at 8');
      assert.ok(edited.body.message.editedAt);
      assert.equal(edited.body.message.sequence, message.sequence); // it keeps its place in the chat
      assert.equal((await bobHears)[0].message.text, 'Dinner at 8');
      await pause(100);
      assert.equal(heard.alice.length, 1); // her other devices
      assert.equal(heard.owner.length, 0); // not in this private chat
      assert.equal((await chat.getConversation(direct, 'bob')).latestMessage.text, 'Dinner at 8');
      // The same text again changes nothing and tells nobody, so a retried request is harmless.
      const again = await edit('alice', message.id, 'Dinner at 8');
      assert.equal(again.status, 200);
      assert.equal(again.body.message.editedAt, edited.body.message.editedAt);
      await pause(100);
      assert.equal(heard.bob.length, 1);

      // ---- a push still waiting in the outbox goes out with the new words ----
      const pushes = [];
      globalThis.fetch = async (_url, options) => {
        pushes.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ data: { status: 'ok', id: 'edit-ticket' } }));
      };
      try { await delivery.processDelivery(await prisma.chatDelivery.findFirst({ where: { messageId: message.id, kind: 'PUSH' } })); }
      finally { globalThis.fetch = originalFetch; }
      assert.equal(pushes[0].data.previewBody, 'Dinner at 8');

      // ---- who may edit, and what ----
      assert.equal((await edit('bob', message.id, 'Not mine')).status, 403);
      assert.equal((await edit('owner', message.id, 'Not my chat')).status, 404);
      assert.equal((await edit(null, message.id, 'Anyone')).status, 401);
      assert.equal((await edit('alice', 'no-such-message', 'Anything')).status, 404);
      assert.equal((await edit('alice', message.id, 'Wrong chat', group)).status, 404);
      for (const text of ['', '   ', 'x'.repeat(4001), 5]) assert.equal((await edit('alice', message.id, text)).status, 400);
      assert.equal((await edit('alice', message.id)).status, 400);

      // ---- too late, or already deleted ----
      const late = (await chat.sendMessage(direct, 'alice', 'edit-too-late', 'Old news')).message;
      await prisma.message.update({ where: { id: late.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
      assert.equal((await edit('alice', late.id, 'Fresh news')).status, 409);
      const gone = (await chat.sendMessage(direct, 'alice', 'edit-deleted', 'Soon gone')).message;
      await remove('alice', [gone.id], 'everyone');
      assert.equal((await edit('alice', gone.id, 'Back again')).status, 409);

      // ---- a photo's caption can change or go; the photo stays ----
      const ticket = (await request('alice', 'POST', `/conversations/${direct}/uploads`)).body.upload;
      const photo = (await request('alice', 'POST', `/conversations/${direct}/messages`, {
        clientMessageId: 'edit-photo', text: 'Before', images: [{ publicId: ticket.publicId, width: 800, height: 600, bytes: 1000, format: 'jpg' }],
      })).body.message;
      const uncaptioned = await edit('alice', photo.id, '');
      assert.equal(uncaptioned.status, 200);
      assert.equal(uncaptioned.body.message.text, '');
      assert.equal(uncaptioned.body.message.images.length, 1);

      // ---- someone who hid the message is not handed its new text; nobody edits what they hid ----
      const hiddenByBob = (await chat.sendMessage(direct, 'alice', 'edit-hidden', 'Bob hides this')).message;
      await remove('bob', [hiddenByBob.id], 'me');
      const bobBefore = heard.bob.length;
      assert.equal((await edit('alice', hiddenByBob.id, 'Bob will not hear this')).status, 200);
      await pause(100);
      assert.equal(heard.bob.length, bobBefore);
      const hiddenByAlice = (await chat.sendMessage(direct, 'alice', 'edit-own-hidden', 'Alice hides this')).message;
      await remove('alice', [hiddenByAlice.id], 'me');
      assert.equal((await edit('alice', hiddenByAlice.id, 'Out of sight')).status, 404);

      // ---- a device that was offline catches up when it reconciles ----
      const reconciled = await request('bob', 'POST', `/conversations/${direct}/messages/reconcile`, {
        messageIds: [message.id, late.id, hiddenByBob.id, gone.id],
      });
      assert.deepEqual(reconciled.body.editedMessages.map(m => [m.id, m.text]), [[message.id, 'Dinner at 8']]);
      assert.deepEqual(reconciled.body.hiddenMessageIds, [hiddenByBob.id]);
      assert.deepEqual(reconciled.body.deletedMessages.map(m => m.id), [gone.id]);
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
    await t.test('delivered and read receipts: positions, live events, honest times and privacy', async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const info = async (user, conversation, messageId) => request(user, 'GET', `/conversations/${conversation}/messages/${messageId}/receipts`);
      const aliceSocket = await socket('alice');
      const bobSocket = await socket('bob');
      const aliceHeard = [], bobHeard = [];
      aliceSocket.on('chat:receipt', event => aliceHeard.push(event));
      bobSocket.on('chat:receipt', event => bobHeard.push(event));

      // ---- a private chat: sent, then delivered, then read ----
      const { message } = await chat.sendMessage(direct, 'alice', 'receipt-first', 'Did this arrive?');
      const before = (await chat.getConversation(direct, 'alice')).receipts;
      assert.deepEqual(before.map(r => r.userId), ['bob']); // only other people, never the caller
      assert.ok(before[0].deliveredSequence < message.sequence && before[0].readSequence <= before[0].deliveredSequence);
      let sheet = await info('alice', direct, message.id);
      assert.deepEqual(sheet.body.receipts.map(r => [r.user.id, r.delivered, r.read, r.deliveredAt, r.readAt]), [['bob', false, false, null, null]]);
      assert.equal(sheet.body.receipts[0].user.email, undefined); // chat never exposes email addresses

      let heard = once(aliceSocket, 'chat:receipt');
      const delivered = await request('bob', 'PATCH', `/conversations/${direct}/delivered`, { sequence: message.sequence });
      assert.deepEqual(delivered, { status: 200, body: { conversationId: direct, deliveredSequence: message.sequence } });
      assert.deepEqual((await heard)[0], { conversationId: direct, userId: 'bob', deliveredSequence: message.sequence, readSequence: before[0].readSequence });
      sheet = await info('alice', direct, message.id);
      assert.equal(sheet.body.receipts[0].delivered, true);
      assert.equal(sheet.body.receipts[0].read, false);
      assert.ok(sheet.body.receipts[0].deliveredAt);

      // A phone that repeats itself, or reports an older position, changes nothing and tells nobody.
      await request('bob', 'PATCH', `/conversations/${direct}/delivered`, { sequence: message.sequence });
      await request('bob', 'PATCH', `/conversations/${direct}/delivered`, { sequence: 1 });
      await pause(150);
      assert.equal(aliceHeard.length, 1);
      assert.equal(bobHeard.length, 0); // the person who moved is not told about their own move
      assert.equal((await request('bob', 'PATCH', `/conversations/${direct}/delivered`, { sequence: 99999 })).status, 400);
      assert.equal((await request('bob', 'PATCH', `/conversations/${direct}/delivered`, { sequence: -1 })).status, 400);

      heard = once(aliceSocket, 'chat:receipt');
      const read = await request('bob', 'PATCH', `/conversations/${direct}/read`, { sequence: message.sequence });
      assert.equal(read.body.receipt, undefined); // the recipient list never leaves the server
      assert.equal((await heard)[0].readSequence, message.sequence);
      sheet = await info('alice', direct, message.id);
      assert.equal(sheet.body.receipts[0].read, true);
      assert.ok(new Date(sheet.body.receipts[0].readAt) >= new Date(sheet.body.receipts[0].deliveredAt));

      // ---- reading a batch is one log row, and an earlier read keeps its own time ----
      const batch = [];
      for (const n of [1, 2, 3]) batch.push((await chat.sendMessage(direct, 'alice', `receipt-batch-${n}`, `Batch ${n}`)).message);
      const rowsBefore = await prisma.chatReceipt.count({ where: { conversationId: direct, userId: 'bob', kind: 'READ' } });
      await chat.markConversationRead(direct, 'bob', batch[2].sequence);
      assert.equal(await prisma.chatReceipt.count({ where: { conversationId: direct, userId: 'bob', kind: 'READ' } }), rowsBefore + 1);
      // A read also counts as a delivery, so the delivered position never falls behind.
      const position = await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId: direct, userId: 'bob' } } });
      assert.equal(position.deliveredSequence, batch[2].sequence);
      const firstRead = (await info('alice', direct, batch[0].id)).body.receipts[0].readAt;
      assert.equal((await info('alice', direct, batch[2].id)).body.receipts[0].readAt, firstRead); // read together, same time
      await pause(30);
      const later = (await chat.sendMessage(direct, 'alice', 'receipt-later', 'One more')).message;
      await chat.markConversationRead(direct, 'bob', later.sequence);
      assert.equal((await info('alice', direct, batch[0].id)).body.receipts[0].readAt, firstRead); // not overwritten by the later read
      assert.ok(new Date((await info('alice', direct, later.id)).body.receipts[0].readAt) > new Date(firstRead));

      // ---- who may ask ----
      assert.equal((await info('bob', direct, message.id)).status, 403); // only the sender
      assert.equal((await info('owner', direct, message.id)).status, 404); // not in this private chat
      assert.equal((await info(null, direct, message.id)).status, 401);
      assert.equal((await info('alice', direct, 'no-such-message')).status, 404);
      assert.equal((await info('alice', other, message.id)).status, 404); // a message from another conversation
      await remove('alice', [later.id], 'everyone');
      assert.equal((await info('alice', direct, later.id)).status, 409);

      // ---- the household chat: late joiners and Clear chat ----
      const shared = await prisma.message.findFirst({ where: { conversationId: group, clientMessageId: 'household-message' } });
      const names = async () => (await info('owner', group, shared.id)).body.receipts.map(r => [r.user.id, r.delivered, r.read]);
      // outsider joined after this message was sent, so is not kept on its waiting list.
      assert.deepEqual(await names(), [['alice', false, false], ['bob', false, false]]);
      await chat.markConversationRead(group, 'outsider', shared.sequence);
      // Having opened the history, they now count as a reader.
      assert.deepEqual(await names(), [['outsider', true, true], ['alice', false, false], ['bob', false, false]]);
      // The household chat names each reader with their own time, exactly like a private chat.
      const reader = (await info('owner', group, shared.id)).body.receipts[0];
      assert.ok(reader.readAt && reader.deliveredAt && !Number.isNaN(Date.parse(reader.readAt)));
      await pause(30);
      await chat.markConversationRead(group, 'bob', shared.sequence);
      const times = Object.fromEntries((await info('owner', group, shared.id)).body.receipts.map(r => [r.user.id, r.readAt]));
      assert.ok(new Date(times.bob) > new Date(times.outsider)); // two people, two different times
      assert.equal(times.alice, null); // she has not read it yet
      const ownerSocket = await socket('owner');
      const ownerHeard = once(ownerSocket, 'chat:receipt');
      assert.equal((await request('alice', 'POST', `/conversations/${group}/clear`)).body.receipt, undefined);
      assert.equal((await ownerHeard)[0].userId, 'alice');
      // Clear chat sweeps messages away without opening them: read, but with no time to claim.
      const cleared = (await info('owner', group, shared.id)).body.receipts.find(r => r.user.id === 'alice');
      assert.deepEqual([cleared.delivered, cleared.read, cleared.deliveredAt, cleared.readAt], [true, true, null, null]);
      const summary = (await chat.getConversation(group, 'owner')).receipts;
      assert.deepEqual(summary.map(r => r.userId).sort(), ['alice', 'bob', 'outsider']);
      assert.ok(summary.every(r => r.deliveredSequence >= r.readSequence && typeof r.joinedAt.getTime === 'function'));
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
    const { drainPresence } = await import('../src/services/presence.service.ts');
    await drainPresence();
    await prisma?.$disconnect();
    // Generated identifier validated before this exact test-only schema removal.
    assert.match(schema, /^chat_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
