import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PresenceRegistry } from '../src/lib/presence.ts';

test('presence counts devices, ignores duplicate disconnects and absorbs reconnects', async () => {
  const changes = [];
  const registry = new PresenceRegistry((id, online, at) => changes.push({ id, online, at }), 15);
  registry.connect('alice', 'phone');
  registry.connect('alice', 'web');
  assert.equal(changes.length, 1);
  registry.disconnect('alice', 'phone');
  registry.disconnect('alice', 'phone');
  await delay(25);
  assert.equal(registry.isOnline('alice'), true);
  registry.disconnect('alice', 'web');
  registry.connect('alice', 'new-web');
  await delay(25);
  assert.equal(changes.length, 1);
  registry.disconnect('alice', 'new-web');
  await delay(25);
  assert.equal(registry.isOnline('alice'), false);
  assert.equal(changes[1].online, false);
  assert.ok(registry.lastSeen('alice') instanceof Date);
  registry.connect('alice', 'phone');
  assert.equal(changes[2].online, true);
  registry.close();
  assert.equal(registry.isOnline('alice'), false);
});
