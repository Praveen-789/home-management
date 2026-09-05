import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { once } from "node:events";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "household-endpoint-test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
const { default: app } = await import("../src/app.ts");
const { default: prisma } = await import("../src/lib/prisma.ts");
const { signToken } = await import("../src/lib/jwt.ts");
const { Prisma } = await import("../generated/prisma/client.ts");
const token = signToken({ userId: "U1", email: "owner@example.com" });
let server;
let url;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/households`;
});
const originalCreate = prisma.household.create;
const mockCreate = (implementation) => {
  const fn = mock.fn(implementation);
  prisma.household.create = fn;
  return fn;
};
afterEach(() => {
  prisma.household.create = originalCreate;
  mock.restoreAll();
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
});

const post = (body, authorization = `Bearer ${token}`) => fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(authorization === null ? {} : { Authorization: authorization }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("rejects missing, malformed, expired and untrusted tokens before writing", async () => {
  const write = mockCreate( async () => { throw new Error("Unexpected write"); });
  const expired = jwt.sign({ userId: "U1", email: "owner@example.com" }, process.env.JWT_SECRET, { expiresIn: -1 });
  const forged = jwt.sign({ userId: "U1", email: "owner@example.com" }, "wrong-secret");
  const badPayload = jwt.sign({ userId: 123, email: "owner@example.com" }, process.env.JWT_SECRET);
  const wrongAlgorithm = jwt.sign({ userId: "U1", email: "owner@example.com" }, process.env.JWT_SECRET, { algorithm: "HS384" });
  for (const auth of [null, "Basic abc", "Bearer", "Bearer invalid", `Bearer ${expired}`, `Bearer ${forged}`, `Bearer ${badPayload}`, `Bearer ${wrongAlgorithm}`]) {
    const response = await post({ name: "Home" }, auth);
    assert.equal(response.status, 401);
    await response.json();
  }
  assert.equal(write.mock.callCount(), 0);
});

test("rejects missing, blank and non-string names before writing", async () => {
  const write = mockCreate( async () => { throw new Error("Unexpected write"); });
  for (const body of [undefined, {}, { name: "" }, { name: "   " }, { name: 123 }, { name: null }, { name: [] }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, "Household name is required");
  }
  assert.equal(write.mock.callCount(), 0);
});

test("creates the JWT user's OWNER membership and ignores ownership supplied in the body", async () => {
  const household = { id: "H1", name: "Praveen's Home", members: [{ id: "M1", userId: "U1", householdId: "H1", role: "OWNER" }] };
  const write = mockCreate( async (args) => {
    assert.equal(args.data.name, "Praveen's Home");
    assert.equal(args.data.members.create.user.connect.id, "U1");
    assert.equal(args.data.members.create.role, "OWNER");
    assert.equal(args.data.id, undefined);
    return household;
  });
  const response = await post({ name: "  Praveen's Home  ", userId: "attacker", role: "MEMBER", id: "injected", members: [{ userId: "attacker" }] });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).household, household);
  assert.equal(write.mock.callCount(), 1);
});

test("returns 401 when the JWT user no longer exists", async () => {
  mockCreate( async () => {
    throw new Prisma.PrismaClientKnownRequestError("Missing connected user", { code: "P2025", clientVersion: "7.10.0" });
  });
  const response = await post({ name: "Home" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).message, "Authenticated user no longer exists");
});

test("returns a generic 500 without exposing database errors", async () => {
  mock.method(console, "error", () => {});
  mockCreate( async () => { throw new Error("Private database details"); });
  const response = await post({ name: "Home" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: "Failed to create household" });
});

