import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';

test('migration backfill, duplicate protection, and per-creator uniqueness in PostgreSQL', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    const schema = `household_test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const path of ['20260831142525_init', '20260901063959_init']) {
      await client.query(await readFile(`prisma/migrations/${path}/migration.sql`, 'utf8'));
    }
    await client.query(`INSERT INTO "User" (id,name,email,password) VALUES ('U1','Owner','one@example.test','unused'),('U2','Other','two@example.test','unused')`);
    await client.query(`INSERT INTO "Household" (id,name) VALUES ('H1','Home'),('H2','Home')`);
    await client.query(`INSERT INTO "HouseholdMember" (id,"userId","householdId",role) VALUES ('M1','U1','H1','OWNER'),('M2','U1','H2','OWNER')`);
    const migration = (await readFile('prisma/migrations/20260906060000_household_creator_unique_name/migration.sql', 'utf8')).replace(/^\uFEFF/, '').replace(/^BEGIN;\s*/m, '').replace(/^COMMIT;\s*/m, '');
    await client.query('SAVEPOINT duplicate_backfill');
    await assert.rejects(client.query(migration), /Resolve duplicate household names/);
    await client.query('ROLLBACK TO SAVEPOINT duplicate_backfill');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM "Household"`)).rows[0].n, 2);
    await client.query(`UPDATE "Household" SET name='Other Home' WHERE id='H2'`);
    await client.query('SAVEPOINT ambiguous_owner');
    await client.query(`DELETE FROM "HouseholdMember" WHERE id='M2'`);
    await assert.rejects(client.query(migration), /exactly one OWNER/);
    await client.query('ROLLBACK TO SAVEPOINT ambiguous_owner');
    await client.query(migration);
    assert.deepEqual((await client.query(`SELECT "createdById" FROM "Household" ORDER BY id`)).rows, [{createdById:'U1'},{createdById:'U1'}]);
    await client.query('SAVEPOINT duplicate_insert');
    await assert.rejects(client.query(`INSERT INTO "Household" (id,name,"createdById") VALUES ('H3','Home','U1')`), {code:'23505'});
    await client.query('ROLLBACK TO SAVEPOINT duplicate_insert');
    await client.query(`INSERT INTO "Household" (id,name,"createdById") VALUES ('H3','Home','U2'),('H4','home','U1')`);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM "Household"`)).rows[0].n, 4);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
