import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
process.env.JWT_SECRET = 'chat-unit-tests';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { directKey, messagePreview } = await import('../src/services/chat.service.ts');
const { validateExpoToken } = await import('../src/services/device-token.service.ts');
const { sendExpoPush, getExpoReceipt, pushPreview } = await import('../src/lib/expo-push.ts');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('private pair keys are order independent and unambiguous', () => {
  assert.equal(directKey('a', 'b'), directKey('b', 'a'));
  assert.notEqual(directKey('a:b', 'c'), directKey('a', 'b:c'));
});
test('device registration accepts Expo tokens and rejects arbitrary input', () => {
  assert.equal(validateExpoToken('ExpoPushToken[abc_123-xyz]'), 'ExpoPushToken[abc_123-xyz]');
  for (const value of [null, {}, '', 'fcm-token', 'ExpoPushToken[]', 'ExpoPushToken[a]\n', 'ExpoPushToken[' + 'x'.repeat(300) + ']']) {
    assert.throws(() => validateExpoToken(value), { statusCode: 400 });
  }
});
test('Expo adapter sends the sender and message preview', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://exp.host/--/api/v2/push/send');
    const body = JSON.parse(options.body);
    assert.equal(body.title, undefined);
    assert.equal(body.data.previewTitle, 'Praveen');
    assert.equal(body.body, undefined);
    assert.equal(body.data.previewBody, 'Dinner is ready');
    assert.equal(body.priority, 'high');
    // The category gives the alert its Reply and Mark as read buttons; the data lets the phone act on them.
    assert.equal(body.data.delivery, 'chat_local_v1');
    const { delivery, previewTitle, previewBody, ...chatData } = body.data;
    assert.deepEqual(chatData, { type: 'CHAT_MESSAGE', conversationId: 'conv', messageId: 'msg', sequence: 7, recipientId: 'user-1' });
    return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket' }] }));
  };
  assert.equal(await sendExpoPush('ExpoPushToken[abc]', { conversationId: 'conv', messageId: 'msg', sequence: 7, recipientId: 'user-1' }, 'Praveen', 'Dinner is ready'), 'ticket');
});
test('alerts show a camera for photos, with the caption when there is one', () => {
  assert.equal(messagePreview({ text: 'Dinner is ready', images: [] }), 'Dinner is ready');
  assert.equal(messagePreview({ text: '', images: [{}] }), '📷 Photo');
  assert.equal(messagePreview({ text: 'Leak under the sink', images: [{}] }), '📷 Leak under the sink');
});
test('push previews normalize whitespace and truncate by Unicode characters', () => {
  assert.equal(pushPreview('  Dinner\n   is ready  '), 'Dinner is ready');
  assert.equal(pushPreview('😀😀😀', 3), '😀😀😀');
  assert.equal(pushPreview('😀😀😀😀', 3), '😀😀…');
});
test('Expo errors distinguish transient and permanent failures', async () => {
  const chatPush = { conversationId: 'c', messageId: 'm', sequence: 1, recipientId: 'u' };
  for (const [status, retryable] of [[429, true], [503, true], [401, false], [400, false]]) {
    globalThis.fetch = async () => new Response('', { status });
    await assert.rejects(sendExpoPush('token', chatPush), error => error.retryable === retryable);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }));
  await assert.rejects(sendExpoPush('token', chatPush), { code: 'DeviceNotRegistered', retryable: false });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }));
  await assert.rejects(sendExpoPush('token', chatPush), { code: 'InvalidExpoResponse', retryable: true });
});
test('receipt polling distinguishes pending, successful and rejected receipts', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }));
  assert.equal(await getExpoReceipt('ticket'), false);
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { ticket: { status: 'ok' } } }));
  assert.equal(await getExpoReceipt('ticket'), true);
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { ticket: { status: 'error', details: { error: 'InvalidCredentials' } } } }));
  await assert.rejects(getExpoReceipt('ticket'), { code: 'InvalidCredentials', retryable: false });
});

test('iOS retains an alert payload with the action category', async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.title, 'Praveen');
    assert.equal(body.body, 'Hello');
    assert.equal(body.categoryId, 'chat_message');
    assert.equal(body.data.delivery, undefined);
    return new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket' } }));
  };
  await sendExpoPush('ExpoPushToken[abc]', { conversationId: 'conv', messageId: 'msg', sequence: 7, recipientId: 'user-1' }, 'Praveen', 'Hello', 'ios');
});