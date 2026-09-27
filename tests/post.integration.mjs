// Uses an isolated, random schema; never resets or migrates application tables.
// Run explicitly: node --import tsx --test tests/post.integration.mjs
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { test } from 'node:test';
import pg from 'pg';

test('posts, photos, likes, comments and notifications on PostgreSQL', { timeout: 120_000 }, async t => {
  const schema = `post_test_${randomUUID().replaceAll('-', '')}`;
  process.env.DATABASE_SCHEMA = schema;
  process.env.JWT_SECRET = 'post-integration-test-secret';
  // Fake credentials: URLs become predictable and nothing can reach Cloudinary.
  process.env.CLOUDINARY_URL = 'cloudinary://test-key:test-secret@test-cloud';
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  let prisma, server;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migrations = (await readdir('prisma/migrations')).filter(name => /^\d/.test(name)).sort();
    for (const name of migrations) await client.query((await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8')).replace(/^﻿/, ''));
    ({ default: prisma } = await import('../src/lib/prisma.ts'));
    const { default: app } = await import('../src/app.ts');
    const { signToken } = await import('../src/lib/jwt.ts');
    const { imageStorage } = await import('../src/lib/cloudinary.ts');
    const destroyed = [];
    imageStorage.destroy = async publicIds => { destroyed.push(...publicIds); };

    await prisma.user.createMany({ data: ['owner', 'admin', 'alice', 'bob', 'outsider'].map(id => ({ id, name: id, email: `${id}@post.test` })) });
    for (const id of ['home', 'other']) {
      await prisma.household.create({ data: { id, name: id, createdById: 'owner', members: { create: [
        { userId: 'owner', role: 'OWNER' }, { userId: 'admin', role: 'ADMIN' }, { userId: 'alice' }, { userId: 'bob' },
      ] } } });
    }
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const token = id => signToken({ userId: id, email: `${id}@post.test` });
    async function request(user, method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    }
    const posts = (household = 'home') => `/households/${household}/posts`;
    const photo = (folder = 'homehub/households/home/posts') => ({ publicId: `${folder}/${randomUUID()}`, width: 1200, height: 900, bytes: 345678, format: 'jpg' });
    const noticesFor = async (type, entityId) =>
      (await prisma.notification.findMany({ where: { type, entityId }, orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }] }));

    let textPost, photoPost, photos;

    await t.test('authentication and household membership', async () => {
      assert.equal((await request(null, 'GET', posts())).status, 401);
      for (const [method, path, body] of [['GET', posts()], ['POST', posts(), { text: 'Hi' }], ['POST', `${posts()}/uploads`]]) {
        assert.deepEqual(await request('outsider', method, path, body), { status: 404, body: { message: 'Household not found or access denied' } });
      }
    });

    await t.test('upload tickets point at the posts folder', async () => {
      const { status, body } = await request('alice', 'POST', `${posts()}/uploads`);
      assert.equal(status, 201);
      assert.match(body.upload.publicId, /^homehub\/households\/home\/posts\/[0-9a-f-]{36}$/);
      assert.equal(body.upload.fields.asset_folder, 'homehub/households/home/posts');
    });

    await t.test('invalid posts are refused before anything is written', async () => {
      const refusals = [
        [{}, 'Post must contain text or a photo'],
        [{ text: '   ' }, 'Post must contain text or a photo'],
        [{ text: 'x'.repeat(4001) }, 'Post text must be at most 4000 characters'],
        [{ text: 42 }, 'Post text must be a string'],
        [{ images: 'photo' }, 'Images must be a list of at most 5 photos'],
        [{ images: Array.from({ length: 6 }, () => photo()) }, 'Images must be a list of at most 5 photos'],
        [{ images: [{ ...photo(), width: 0 }] }, 'Width must be an integer between 1 and 20000'],
        // A task photo, another household's post photo, and a chat photo are all in the wrong folder.
        [{ images: [photo('homehub/households/home')] }, "Photo was not uploaded for this household's posts"],
        [{ images: [photo('homehub/households/other/posts')] }, "Photo was not uploaded for this household's posts"],
        [{ images: [photo(`homehub/households/home/chat/${randomUUID()}`)] }, "Photo was not uploaded for this household's posts"],
      ];
      for (const [body, message] of refusals) assert.deepEqual(await request('alice', 'POST', posts(), body), { status: 400, body: { message } });
      const twice = photo();
      assert.deepEqual(await request('alice', 'POST', posts(), { images: [twice, twice] }), { status: 400, body: { message: 'The same photo was added twice' } });
      assert.equal(await prisma.post.count(), 0);
    });

    await t.test('a text post notifies every other member', async () => {
      const { status, body } = await request('alice', 'POST', posts(), { text: '  Pizza night on Friday!  ', authorId: 'owner', householdId: 'other' });
      assert.equal(status, 201);
      textPost = body.post;
      assert.equal(textPost.text, 'Pizza night on Friday!');
      assert.equal(textPost.householdId, 'home');
      assert.deepEqual(textPost.author, { id: 'alice', name: 'alice', email: 'alice@post.test', avatarUrl: null });
      assert.deepEqual([textPost.images, textPost.likeCount, textPost.commentCount, textPost.likedByMe], [[], 0, 0, false]);
      const notices = await noticesFor('POST_CREATED', textPost.id);
      assert.deepEqual(notices.map(n => n.userId), ['admin', 'bob', 'owner']);
      assert.deepEqual(notices.map(n => [n.title, n.message, n.householdId]), Array(3).fill(['New household post', 'alice: Pizza night on Friday!', 'home']));
    });

    await t.test('a photo-only post keeps the photos in the order they were picked', async () => {
      photos = [photo(), photo(), photo()];
      const { status, body } = await request('bob', 'POST', posts(), { text: null, images: photos });
      assert.equal(status, 201);
      photoPost = body.post;
      assert.equal(photoPost.text, '');
      assert.deepEqual(photoPost.images.map(image => image.url), photos.map(p => `https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto/${p.publicId}`));
      assert.equal(photoPost.images[0].uploadedBy.id, 'bob');
      assert.equal(photoPost.images[0].publicId, undefined);
      assert.equal((await request('bob', 'GET', `${posts()}/${photoPost.id}`)).body.post.images.map(i => i.url).join(), photoPost.images.map(i => i.url).join());
      assert.equal((await noticesFor('POST_CREATED', photoPost.id))[0].message, 'bob: 📷 3 photos');
      // A photo already posted cannot be posted again, and nothing of the new post is kept.
      assert.deepEqual(await request('bob', 'POST', posts(), { text: 'Again', images: [photos[0]] }), { status: 409, body: { message: 'This photo was already posted' } });
      assert.equal(await prisma.post.count(), 2);
    });

    await t.test('the database keeps each image to exactly one parent', async () => {
      const task = await prisma.task.create({ data: { title: 'Fix sink', householdId: 'home', createdById: 'owner' } });
      await assert.rejects(prisma.image.create({ data: {
        ...photo(), householdId: 'home', taskId: task.id, postId: textPost.id, uploadedById: 'owner',
      } }), /Image_single_parent_check/);
      await assert.rejects(prisma.post.create({ data: { householdId: 'home', authorId: 'owner', text: '   ' } }), /Post_text_check/);
    });

    await t.test('the feed pages newest first without skipping or repeating posts', async () => {
      for (const text of ['Third', 'Fourth', 'Fifth']) assert.equal((await request('owner', 'POST', posts(), { text })).status, 201);
      assert.equal((await request('owner', 'POST', posts('other'), { text: 'Elsewhere' })).status, 201);
      const first = await request('alice', 'GET', `${posts()}?limit=2`);
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.posts.map(p => p.text), ['Fifth', 'Fourth']);
      assert.equal(typeof first.body.nextCursor, 'string');
      // A post made between pages appears on the next first page, not in the middle of this walk.
      assert.equal((await request('owner', 'POST', posts(), { text: 'Sixth' })).status, 201);
      const second = await request('alice', 'GET', `${posts()}?limit=2&cursor=${first.body.nextCursor}`);
      assert.deepEqual(second.body.posts.map(p => p.text), ['Third', '']);
      const last = await request('alice', 'GET', `${posts()}?limit=2&cursor=${second.body.nextCursor}`);
      assert.deepEqual(last.body.posts.map(p => p.text), ['Pizza night on Friday!']);
      assert.equal(last.body.nextCursor, null);
      assert.equal((await request('alice', 'GET', posts())).body.posts.length, 6);

      // Posts from the same millisecond are told apart by ID.
      const at = new Date('2026-09-01T10:00:00.000Z');
      await prisma.post.createMany({ data: ['a', 'b', 'c'].map(text => ({ householdId: 'other', authorId: 'owner', text, createdAt: at })) });
      const seen = [];
      let cursor = null;
      do {
        const page = await request('bob', 'GET', `${posts('other')}?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.body.posts.map(p => p.text));
        cursor = page.body.nextCursor;
      } while (cursor);
      assert.deepEqual([seen[0], [...seen.slice(1)].sort()], ['Elsewhere', ['a', 'b', 'c']]);

      for (const query of ['cursor=nonsense', `cursor=${'x'.repeat(201)}`, 'limit=0', 'limit=51', 'limit=abc']) {
        assert.equal((await request('alice', 'GET', `${posts()}?${query}`)).status, 400, query);
      }
    });

    await t.test('a post is only found in its own household', async () => {
      assert.deepEqual(await request('alice', 'GET', `${posts('other')}/${textPost.id}`), { status: 404, body: { message: 'Post not found' } });
      assert.equal((await request('outsider', 'GET', `${posts()}/${textPost.id}`)).status, 404);
    });

    await t.test('likes are one per person and repeat safely', async () => {
      const like = user => request(user, 'PUT', `${posts()}/${textPost.id}/like`);
      const unlike = user => request(user, 'DELETE', `${posts()}/${textPost.id}/like`);
      assert.deepEqual([(await like('bob')).body.post.likeCount, (await like('bob')).body.post.likeCount], [1, 1]);
      assert.equal((await like('bob')).body.post.likedByMe, true);
      const asAlice = (await request('alice', 'GET', `${posts()}/${textPost.id}`)).body.post;
      assert.deepEqual([asAlice.likeCount, asAlice.likedByMe], [1, false]);
      assert.equal((await like('alice')).body.post.likeCount, 2);
      const feed = (await request('alice', 'GET', posts())).body.posts.find(p => p.id === textPost.id);
      assert.deepEqual([feed.likeCount, feed.likedByMe], [2, true]);
      const removed = [(await unlike('bob')).body, (await unlike('bob')).body];
      assert.deepEqual(removed.map(b => [b.message, b.post.likeCount, b.post.likedByMe]), [['Like removed', 1, false], ['Like removed', 1, false]]);
      // Likes send no notification.
      assert.equal(await prisma.notification.count({ where: { entityId: textPost.id, type: { not: 'POST_CREATED' } } }), 0);
      assert.equal((await request('alice', 'PUT', `${posts()}/missing/like`)).status, 404);
    });

    let bobComment, aliceComment;
    await t.test('comments notify the post author, never the commenter', async () => {
      const comment = (user, text, post = textPost) => request(user, 'POST', `${posts()}/${post.id}/comments`, { text });
      const first = await comment('bob', '  Count me in  ');
      assert.equal(first.status, 201);
      bobComment = first.body.comment;
      assert.deepEqual({ ...bobComment, id: undefined, createdAt: undefined }, {
        id: undefined, createdAt: undefined, postId: textPost.id, text: 'Count me in',
        author: { id: 'bob', name: 'bob', email: 'bob@post.test', avatarUrl: null },
      });
      aliceComment = (await comment('alice', 'Great!')).body.comment;
      assert.equal((await comment('owner', 'x'.repeat(1000))).status, 201);
      const notices = await noticesFor('POST_COMMENTED', textPost.id);
      // The comment is not quoted, so deleting it later leaves nothing of it in the inbox.
      assert.deepEqual(notices.map(n => [n.userId, n.title, n.message]), [
        ['alice', 'New comment on your post', 'bob commented on your post'],
        ['alice', 'New comment on your post', 'owner commented on your post'],
      ]);
      for (const [body, message] of [[{ text: '   ' }, 'Comment text is required'], [{}, 'Comment text is required'], [{ text: 'x'.repeat(1001) }, 'Comment text must be at most 1000 characters']]) {
        assert.deepEqual(await request('bob', 'POST', `${posts()}/${textPost.id}/comments`, body), { status: 400, body: { message } });
      }
      assert.equal((await request('bob', 'GET', `${posts()}/${textPost.id}`)).body.post.commentCount, 3);
    });

    await t.test('comments page oldest first', async () => {
      const path = `${posts()}/${textPost.id}/comments`;
      const first = await request('alice', 'GET', `${path}?limit=2`);
      assert.deepEqual(first.body.comments.map(c => c.id), [bobComment.id, aliceComment.id]);
      const rest = await request('alice', 'GET', `${path}?limit=2&cursor=${first.body.nextCursor}`);
      assert.deepEqual([rest.body.comments.length, rest.body.comments[0].author.id, rest.body.nextCursor], [1, 'owner', null]);
      assert.equal((await request('alice', 'GET', `${posts('other')}/${textPost.id}/comments`)).status, 404);
    });

    await t.test('members delete their own comments; owners and admins delete anyone\'s', async () => {
      const remove = (user, comment, post = textPost) => request(user, 'DELETE', `${posts()}/${post.id}/comments/${comment.id}`);
      assert.deepEqual(await remove('alice', bobComment), { status: 403, body: { message: 'You can only delete your own comments' } });
      assert.deepEqual(await remove('bob', bobComment, photoPost), { status: 404, body: { message: 'Comment not found' } });
      assert.deepEqual(await remove('bob', bobComment), { status: 200, body: { message: 'Comment deleted successfully' } });
      assert.equal((await remove('bob', bobComment)).status, 404);
      assert.equal((await remove('admin', aliceComment)).status, 200);
      assert.equal((await request('bob', 'GET', `${posts()}/${textPost.id}`)).body.post.commentCount, 1);
    });

    await t.test('members delete their own posts; owners and admins delete anyone\'s', async () => {
      assert.deepEqual(await request('alice', 'DELETE', `${posts()}/${photoPost.id}`), { status: 403, body: { message: 'You can only delete your own posts' } });
      assert.equal((await request('owner', 'DELETE', `${posts('other')}/${photoPost.id}`)).status, 404);

      await prisma.postLike.create({ data: { postId: photoPost.id, userId: 'alice' } });
      await prisma.postComment.create({ data: { postId: photoPost.id, authorId: 'alice', text: 'Lovely' } });
      assert.deepEqual(await request('bob', 'DELETE', `${posts()}/${photoPost.id}`), { status: 200, body: { message: 'Post deleted successfully' } });
      assert.deepEqual([...destroyed].sort(), photos.map(p => p.publicId).sort());
      const left = await Promise.all([
        prisma.image.count({ where: { postId: photoPost.id } }),
        prisma.postLike.count({ where: { postId: photoPost.id } }),
        prisma.postComment.count({ where: { postId: photoPost.id } }),
      ]);
      assert.deepEqual(left, [0, 0, 0]);
      assert.equal((await noticesFor('POST_CREATED', photoPost.id)).length, 0);

      // A post removed by an admin takes its quoted notifications with it, and nothing else.
      const others = await prisma.notification.count({ where: { entityId: { not: textPost.id } } });
      assert.equal((await noticesFor('POST_CREATED', textPost.id)).length, 3);
      assert.equal((await request('admin', 'DELETE', `${posts()}/${textPost.id}`)).status, 200);
      assert.equal((await request('alice', 'GET', `${posts()}/${textPost.id}`)).status, 404);
      assert.equal(await prisma.notification.count({ where: { entityId: textPost.id } }), 0);
      assert.equal(await prisma.notification.count({ where: { entityId: { not: textPost.id } } }), others);
    });

    await t.test('a post stays after its author leaves, and they are no longer notified', async () => {
      const post = (await request('bob', 'POST', posts(), { text: 'Moving out soon' })).body.post;
      await prisma.householdMember.delete({ where: { userId_householdId: { userId: 'bob', householdId: 'home' } } });
      assert.equal((await request('bob', 'GET', `${posts()}/${post.id}`)).status, 404);
      assert.equal((await request('alice', 'GET', `${posts()}/${post.id}`)).body.post.author.id, 'bob');
      assert.equal((await request('alice', 'POST', `${posts()}/${post.id}/comments`, { text: 'We will miss you' })).status, 201);
      assert.equal((await noticesFor('POST_COMMENTED', post.id)).length, 0);
      // A member removes a former member's post only as an owner or admin.
      assert.equal((await request('alice', 'DELETE', `${posts()}/${post.id}`)).status, 403);
      assert.equal((await request('owner', 'DELETE', `${posts()}/${post.id}`)).status, 200);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await prisma?.$disconnect();
    // Generated identifier validated before this exact test-only schema removal.
    assert.match(schema, /^post_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
