# HomeHub API

Documentation for the currently implemented endpoints.

Household/private chat, live socket events, device registration, and chat push delivery are documented in [CHAT.md](CHAT.md).

## Local server

Base URL: `http://localhost:3000/api`

With dependencies installed, the Prisma client generated, and database migrations applied, configure `DATABASE_URL` and `JWT_SECRET` in your local `.env`, then start the server:

```sh
npm start
```

Send request bodies as JSON with `Content-Type: application/json`.
IDs and timestamps below are examples; the server generates actual values.

## Endpoints

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | None | Register a user |
| POST | `/api/auth/login` | None | Obtain a JWT |
| POST | `/api/households` | Bearer JWT | Create a household and its owner membership |
| GET | `/api/users/me` | Bearer JWT | The signed-in user's profile, see [Profile pictures](#profile-pictures) |

## Authentication

Register, then log in. Copy the `token` from the login response and send it on protected requests:

```http
Authorization: Bearer <token>
```

Login tokens expire after 7 days. Log in again to obtain a new token. The household endpoint verifies the token's signature and expiration and reads `userId` from its payload.

## Register a user

`POST /api/auth/register`

### Request

```json
{
  "name": "Praveen",
  "email": "praveen@example.com",
  "password": "ExamplePassword123!"
}
```

| Field | Expected type | Description |
| --- | --- | --- |
| `name` | string | User's name |
| `email` | string | Unique email address |
| `password` | string | Password; stored as a bcrypt hash |

### Success: 201 Created

```json
{
  "message": "User registered successfully",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Praveen",
    "email": "praveen@example.com",
    "avatarUrl": null
  }
}
```

Registration does not issue a token. Use the login endpoint next. The response excludes the password and its hash.

### Errors

| Status | Message | Condition |
| --- | --- | --- |
| 400 | `User already exists` | The email was found by the duplicate-user check |
| 400 | Error message, or `Registration failed` | Other registration failures |

Current behavior: registration has no explicit field, email-format, or password-strength validation. Missing or invalid fields can produce underlying library/database error messages; these messages are not a stable API contract.

## Log in

`POST /api/auth/login`

### Request

```json
{
  "email": "praveen@example.com",
  "password": "ExamplePassword123!"
}
```

Both fields must be strings. Email and password are used as supplied, without trimming or case normalization.

### Success: 200 OK

```json
{
  "message": "Login successful",
  "token": "<jwt-token>",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Praveen",
    "email": "praveen@example.com",
    "avatarUrl": null
  }
}
```

### Errors

| Status | Message | Condition |
| --- | --- | --- |
| 400 | `Email and password are required` | A field is missing or is not a string in a parsed request body |
| 401 | `Invalid email or password` | User does not exist or password does not match |
| 500 | `Login failed` | Unexpected failure; currently also returned when no parsed body is available |

## Create a household

`POST /api/households`

Requires `Authorization: Bearer <token>`.

### Request

```json
{
  "name": "Praveen's Home"
}
```

`name` must be a non-empty string. Leading and trailing whitespace is removed; whitespace-only names are rejected.

The server takes the user ID from the verified JWT and always assigns `OWNER`. Extra body properties, including `userId`, `createdById`, `createdBy`, `role`, `id`, and `members`, are ignored.

### Database behavior

A single Prisma nested write creates:

1. A `Household` with the supplied name.
2. A `HouseholdMember` linked to that household and the authenticated user, with `role: OWNER`.

Both records are created atomically. If the membership cannot be created, the household creation rolls back. The database enforces a unique combination of `createdById` and `name`, including concurrent requests. Repeating a name for the same creator returns `409 Conflict`. Different creators may use the same name. Names are trimmed and case-sensitive (`Home` and `home` are different). The creator is stored separately from membership roles.

### Success: 201 Created

```json
{
  "message": "Household created successfully",
  "household": {
    "id": "22222222-2222-4222-8222-222222222222",
    "name": "Praveen's Home",
    "createdById": "11111111-1111-4111-8111-111111111111",
    "createdAt": "2026-09-05T10:00:00.000Z",
    "members": [
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "userId": "11111111-1111-4111-8111-111111111111",
        "householdId": "22222222-2222-4222-8222-222222222222",
        "role": "OWNER",
        "joinedAt": "2026-09-05T10:00:00.000Z"
      }
    ]
  }
}
```

### Errors

| Status | Message | Condition |
| --- | --- | --- |
| 400 | `Household name is required` | Missing, non-string, empty, or whitespace-only name |
| 401 | `Bearer token is required` | Missing authorization header or incorrect Bearer header format |
| 401 | `Invalid or expired token` | JWT verification or payload validation fails |
| 401 | `Authenticated user no longer exists` | The user referenced by the JWT cannot be connected during creation |
| 409 | `You already have a household with this name` | The creator already has a household with this name |
| 500 | `Failed to create household` | Unexpected creation failure |

Authentication runs before household-name validation.

## Error response format

Controller and authentication errors use:

```json
{
  "message": "Household name is required"
}
```

Malformed JSON is rejected by Express before the controller, with status `400`. There is currently no custom global error handler, so parser errors and unmatched routes may return non-JSON responses.

## Try the complete flow in PowerShell

Run against the local development server. Registration requires an unused email address; if already registered, skip the registration call and log in with the existing credentials.

```powershell
$apiBase = 'http://localhost:3000/api'

$registrationBody = @{
  name = 'Praveen'
  email = 'praveen@example.com'
  password = 'ExamplePassword123!'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$apiBase/auth/register" -ContentType 'application/json' -Body $registrationBody

$loginBody = @{
  email = 'praveen@example.com'
  password = 'ExamplePassword123!'
} | ConvertTo-Json

$loginResponse = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" -ContentType 'application/json' -Body $loginBody

$authHeaders = @{ Authorization = "Bearer $($loginResponse.token)" }
$householdBody = @{ name = "Praveen's Home" } | ConvertTo-Json

$createdHousehold = Invoke-RestMethod -Method Post -Uri "$apiBase/households" -Headers $authHeaders -ContentType 'application/json' -Body $householdBody
$createdHousehold | ConvertTo-Json -Depth 5
```

## curl example (Bash)

Replace `<token>` with the login response token:

```bash
curl -i -X POST 'http://localhost:3000/api/households' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name":"My Home"}'
```

## Postman

1. Create a POST request using an endpoint URL from the table above.
2. Under **Body**, choose **raw** and **JSON**, then paste its request example.
3. Register and log in, then copy the login response's `token`.
4. For household creation, select **Authorization > Bearer Token** and paste the token without the `Bearer` prefix.
5. Send the household request and expect `201 Created` with one `OWNER` membership.

## Verification

```sh
npm test
npx tsc --noEmit
```

The current automated HTTP tests cover household authentication, input validation, owner assignment, missing users, and generic database errors. These HTTP tests mock Prisma writes. For a real PostgreSQL test of migration backfill, duplicate rejection, and names shared by different creators, run `node --test tests/household-uniqueness.integration.mjs`. It uses `DATABASE_URL`, creates an isolated schema inside a transaction, and rolls back all test data and schema changes.

## Implementation references

- [Route registration](src/app.ts)
- [Authentication controller](src/controllers/auth.controller.ts)
- [Authentication service](src/services/auth.service.ts)
- [JWT helpers](src/lib/jwt.ts)
- [Authentication middleware](src/middleware/auth.middleware.ts)
- [Household controller](src/controllers/household.controller.ts)
- [Household service](src/services/household.service.ts)
- [Task controller](src/controllers/task.controller.ts)
- [Task service](src/services/task.service.ts)
- [Task routes](src/routes/task.routes.ts)
- [Prisma schema](prisma/schema.prisma)

## Creator uniqueness migration

Apply the migration before running the updated application:

```sh
npx prisma migrate deploy
npx prisma generate
```

Existing households are assigned their sole OWNER as creator. The migration stops without changing records if any household has zero/multiple owners or if duplicate names exist for an owner. Resolve these records before applying it; the migration does not delete or rename households. Creator references use `onDelete: Restrict`, preventing deletion of a user while households still reference them as creator.

## Household members

All endpoints require a Bearer token and the requester must belong to the household.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/households/:householdId/members` | None | 200 `{ message, members }` |
| PATCH | `/api/households/:householdId/members/:userId` | `{ "role": "ADMIN" }` | 200 `{ message, member }` |
| DELETE | `/api/households/:householdId/members/:userId` | None | 200 `{ message }` |

People are never added directly. `POST /api/households/:householdId/members` no longer exists (404); an owner or admin sends an invitation and the membership is created when the invited user accepts. See **Household invitations** below.

PATCH requires a role. Only `ADMIN` and `MEMBER` are assignable. IDs must be nonblank strings. Extra body properties are ignored. The `:userId` parameter is a User ID, not a membership ID.

GET returns:

```json
{
  "message": "Household members fetched successfully",
  "members": [
    {
      "id": "membership-id",
      "role": "OWNER",
      "user": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null }
    }
  ]
}
```

Members are ordered by joining time, then membership ID. PATCH returns the same member fields. Passwords are never selected.

| Permission | OWNER | ADMIN | MEMBER |
| --- | --- | --- | --- |
| List members | Yes | Yes | Yes |
| Invite as MEMBER, or cancel such an invitation | Yes | Yes | No |
| Invite as ADMIN, or cancel such an invitation | Yes | No | No |
| Change MEMBER to ADMIN or ADMIN to MEMBER | Yes | No | No |
| Remove MEMBER | Yes | Yes | No |
| Remove ADMIN | Yes | No | No |
| Assign, demote, or remove OWNER | No | No | No |

An authorized update to the current role succeeds (including ADMIN updating a MEMBER to MEMBER). Self-removal is unsupported. DELETE removes membership only, not the user. Ownership transfer is outside these endpoints.

Errors use `{ "message": "..." }`: `400` for invalid input, `401` for invalid/missing authentication, `403` for prohibited management actions, `404` for missing targets or inaccessible households, `409` for duplicate membership or exhausted concurrency retries, and a generic `500` for unexpected failures. Missing and inaccessible households share `Household not found or access denied`.

Membership checks and operations run in serializable transactions. Conflicts retry the entire operation up to three attempts, re-reading permissions. The composite unique constraint on memberships also protects against two simultaneous acceptances.

Member HTTP tests in `tests/household-member.test.mjs` cover role combinations, authentication, access restrictions, safe response fields, validation, missing targets, duplicate errors, and simulated transaction conflicts. They mock Prisma; they do not verify PostgreSQL concurrency behavior against a live database.

## Household invitations

Nobody joins a household without agreeing to it. An owner or admin invites a registered user; that user sees the invitation in their notifications and on their household list, and becomes a member only by accepting. All endpoints require a Bearer token.

| Method | Path | Who | Body | Success |
| --- | --- | --- | --- | --- |
| POST | `/api/households/:householdId/invitations` | OWNER, ADMIN | `{ "email": "member@example.com", "role": "MEMBER" }` or `{ "userId": "existing-user-id", "role": "MEMBER" }` | 201 `{ message, invitation }` |
| GET | `/api/households/:householdId/invitations` | Any member | None | 200 `{ message, invitations }` |
| DELETE | `/api/households/:householdId/invitations/:invitationId` | OWNER, ADMIN | None | 200 `{ message }` |
| GET | `/api/invitations` | The invited user | None | 200 `{ message, invitations }` |
| POST | `/api/invitations/:id/accept` | The invited user | None | 200 `{ message, member, household }` |
| POST | `/api/invitations/:id/decline` | The invited user | None | 200 `{ message }` |

```json
{
  "id": "invitation-id",
  "role": "MEMBER",
  "createdAt": "2026-09-20T10:00:00.000Z",
  "household": { "id": "household-id", "name": "Family Home", "pictureUrl": null },
  "invitedUser": { "id": "user-id", "name": "Asha", "email": "asha@example.com", "avatarUrl": null },
  "invitedBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null }
}
```

Both lists are newest first and return only pending invitations, because an invitation exists only while it is pending: accepting replaces it with a membership, and declining or cancelling deletes it. `/api/invitations` takes the user from the token; a user ID in the query or body is ignored.

**Inviting.** POST identifies the user by exactly one of `email` or `userId`. The email is trimmed and then matched exactly against the address the user registered with (case-sensitive, like login). Sending neither returns `400` `User ID or email address is required`; sending both returns `400` `Provide either a user ID or an email address, not both`; a blank value returns `400` `Email address is required` or `User ID is required`. An omitted role defaults to `MEMBER`; only `ADMIN` and `MEMBER` are accepted. The role matrix is the one in **Household members**, and it is checked before the lookup, so a requester who may not invite learns nothing about whether an email is registered. An unregistered email or unknown ID returns `404` `User not found`. `409` `User is already a household member` and `409` `User already has a pending invitation to this household` cover the two duplicates; the database also enforces one pending invitation per user and household.

**Cancelling** follows the same matrix against the invitation's role, so an admin cannot cancel an owner's admin invitation. The invited user is not notified; their invitation notification simply stops working (404 on accept).

**Accepting** creates the membership with the invited role and deletes the invitation in one transaction. The invitation is honoured only while its sender could still send it: if the sender has left the household, or was an admin who has since been demoted, accept returns `409` `This invitation is no longer valid. You can decline it.` and changes nothing. A missing invitation and another user's invitation both return `404` `Invitation not found`.

**Notifications**, each saved in the same transaction as the change it reports:

| Event | Recipient | Type | Message | `householdId` / `entityId` |
| --- | --- | --- | --- | --- |
| Invited | Invited user | `HOUSEHOLD_INVITATION` | `Praveen wants to add you to Family Home as member.` | household / invitation ID |
| Accepted | Sender | `MEMBER_JOINED` | `Asha accepted your invitation to Family Home.` | household / null |
| Declined | Sender, if still a member | `INVITATION_DECLINED` | `Asha declined your invitation to Family Home.` | household / null |

The invited user is not a member yet, so a client must not open the household from a `HOUSEHOLD_INVITATION` notification; it offers accept and decline with the `entityId` instead.

Errors use `{ "message": "..." }` with the statuses above, `401` for authentication, `403` for the role matrix, `404` `Household not found or access denied` for non-members on the household routes, and a generic `500` `Household invitation operation failed`. Operations run in serializable transactions with the same three-attempt retry as members. Requires the `add_household_invitation` migration. Tests: `tests/household-invitation.test.mjs` (Prisma mocked).

To try it: as A, POST an invitation for B's email. As B, GET `/api/invitations` and `/api/notifications`, confirm GET `/api/households` does not list the household yet, then POST accept and confirm it does. Check A's inbox for the acceptance. Repeat with decline, and with A cancelling before B answers.

## List my households

`GET /api/households`

Requires `Authorization: Bearer <token>`. No request body is needed. The user ID comes from the verified token; query parameters cannot override it.

Returns all households the requester belongs to, including households created by other users. Each `role` is the requester's role in that household. Results are ordered by household creation time (newest first), then household ID. This endpoint currently returns the full list without pagination.

### Success: 200 OK

```json
{
  "message": "Households fetched successfully",
  "households": [
    {
      "id": "household-id",
      "name": "My Home",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "pictureUrl": null,
      "role": "OWNER"
    }
  ]
}
```

`pictureUrl` is the household's picture, or `null` when none is set. See [Profile pictures](#profile-pictures).

A user with no memberships receives `200` with `households: []`. No other members or user details are returned. Invalid/missing tokens return `401`; unexpected failures return `500` with `Failed to fetch households`. A valid token for a deleted user also yields an empty list because they have no memberships.

## Tasks

All endpoints require a Bearer token and the requester must belong to the household. A task belongs to exactly one household and is reachable only through that household's path.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/households/:householdId/tasks` | None; optional query `status`, `page`, `limit` | 200 `{ message, tasks, pagination }` |
| POST | `/api/households/:householdId/tasks` | `{ "title": "Buy groceries", "description": "Milk and eggs", "status": "TODO", "priority": "HIGH", "dueDate": "2026-09-10T18:00:00.000Z", "assignedToId": "user-id" }` | 201 `{ message, task }` |
| GET | `/api/households/:householdId/tasks/:taskId` | None | 200 `{ message, task }` |
| PATCH | `/api/households/:householdId/tasks/:taskId` | Any subset of the POST fields | 200 `{ message, task }` |
| DELETE | `/api/households/:householdId/tasks/:taskId` | None | 200 `{ message }` |

### Fields

| Field | Type | Rules |
| --- | --- | --- |
| `title` | string | Required on POST. Trimmed; blank values return `400` `Title is required`. |
| `description` | string or null | Optional. Trimmed; a blank string is stored as `null`. |
| `status` | `TODO`, `IN_PROGRESS`, `DONE` | Optional. Defaults to `TODO`. |
| `priority` | `LOW`, `MEDIUM`, `HIGH` | Optional. Defaults to `MEDIUM`. |
| `dueDate` | ISO 8601 string or null | Optional. Parsed by JavaScript `Date`; unparseable values return `400`. |
| `assignedToId` | User ID or null | Optional. The user must belong to the household, otherwise `400` `Assignee must be a member of this household`. |

PATCH accepts any subset of these fields and changes only what is sent. Send `null` to clear `description`, `dueDate`, or `assignedToId`. A PATCH containing none of these fields returns `400`. Unknown properties are ignored everywhere. The household comes from the URL and the creator from the token, so `householdId`, `createdById`, and `id` in a body are ignored.

### Response shape

```json
{
  "message": "Task fetched successfully",
  "task": {
    "id": "task-id",
    "householdId": "household-id",
    "title": "Buy groceries",
    "description": "Milk and eggs",
    "status": "TODO",
    "priority": "HIGH",
    "dueDate": "2026-09-10T18:00:00.000Z",
    "createdAt": "2026-09-08T07:00:00.000Z",
    "updatedAt": "2026-09-08T07:00:00.000Z",
    "createdBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null },
    "assignedTo": { "id": "other-user-id", "name": "Ravi", "email": "ravi@example.com", "avatarUrl": null }
  }
}
```

### Listing, filtering, and pagination

The list endpoint accepts optional query parameters:

| Parameter | Type | Default | Rules |
| --- | --- | --- | --- |
| `status` | `TODO`, `IN_PROGRESS`, `DONE` | none | Return only tasks with this status. |
| `page` | integer | 1 | 1-based page number, at most 100000. |
| `limit` | integer | 20 | Tasks per page, 1 to 100. |

Example: `GET /api/households/:householdId/tasks?status=TODO&page=2&limit=10`. Values must be plain digits or an exact status name. Anything else, including a repeated parameter, returns `400` with the rule in the message.

Tasks are ordered by due date (soonest first, undated tasks last), then creation time (newest first), then ID, so pages stay stable while no task changes. Each entry has the task shape shown above, and the response adds the page details:

```json
{
  "message": "Tasks fetched successfully",
  "tasks": [{ "id": "task-id", "title": "Buy groceries", "status": "TODO" }],
  "pagination": { "page": 2, "limit": 10, "total": 23, "totalPages": 3 }
}
```

`total` counts every task matching the filter, not only those on the page, and `totalPages` is `0` when nothing matches. A page past the end returns `200` with an empty `tasks` array. Passwords are never selected.

### Permissions

| Action | OWNER / ADMIN | MEMBER who created the task | MEMBER assigned to the task | Other MEMBER |
| --- | --- | --- | --- | --- |
| List and view | Yes | Yes | Yes | Yes |
| Create | Yes | Yes | Yes | Yes |
| Update any field | Yes | Yes | No | No |
| Update `status` only | Yes | Yes | Yes | No |
| Delete | Yes | Yes | No | No |

The `status`-only rule lets an assignee mark their own chore done without renaming, reassigning, or deleting it. An assignee sending any other field receives `403` `Assignees can only update the task status`. A member with no relation to the task receives `403` `You can only update tasks you created or are assigned to` on PATCH and `403` `You can only manage tasks you created` on DELETE.

### Errors

Errors use `{ "message": "..." }`: `400` for invalid input or a non-member assignee, `401` for missing or invalid authentication, `403` for prohibited updates and deletes, `404` `Household not found or access denied` for missing or inaccessible households, `404` `Task not found` for a missing task in an accessible household, `404` `Household, member, or task no longer exists` when a referenced row disappears mid-write, `409` `Tasks changed concurrently; please retry` after three serialization retries, and `500` `Task operation failed` for unexpected failures.

Task operations run in serializable transactions with the same retry behavior as household members, through the shared wrapper in `src/lib/transaction.ts`. This module requires the `add_task` migration:

```sh
npx prisma migrate deploy
npx prisma generate
```

Task HTTP tests in `tests/task.test.mjs` cover authentication, household access, list filtering and pagination, every role and ownership combination for update and delete, the status-only assignee rule, validation messages, assignee membership checks, null clearing, missing tasks, and simulated transaction conflicts. They mock Prisma.

## Expenses

All endpoints require a Bearer token and the requester must belong to the household. An expense belongs to exactly one household. It may point at a task in the same household, or stand alone (rent, a utility bill). A task never needs an expense, a task may have several, and deleting a task keeps its expenses and clears their `task` link.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/households/:householdId/expenses` | None; optional query `category`, `paidById`, `taskId`, `from`, `to`, `page`, `limit` | 200 `{ message, expenses, pagination }` |
| GET | `/api/households/:householdId/expenses/summary` | None; optional query `category`, `paidById`, `taskId`, `from`, `to` | 200 `{ message, summary }` |
| POST | `/api/households/:householdId/expenses` | `{ "amount": 1250.5, "description": "Weekly groceries", "category": "GROCERIES", "paidById": "user-id", "taskId": "task-id" }` | 201 `{ message, expense }` |
| GET | `/api/households/:householdId/expenses/:expenseId` | None | 200 `{ message, expense }` |
| PATCH | `/api/households/:householdId/expenses/:expenseId` | Any subset of the POST fields | 200 `{ message, expense }` |
| DELETE | `/api/households/:householdId/expenses/:expenseId` | None | 200 `{ message }` |

### Fields

| Field | Type | Rules |
| --- | --- | --- |
| `amount` | number or numeric string | Required on POST. Positive, below 10000000000, at most 2 decimal places. Validated as text so nothing passes through a float: `1250`, `1250.5`, and `"1250.50"` are all stored as `1250.50`. Anything else returns `400` `Amount must be a positive number below 10000000000 with at most 2 decimal places`. |
| `description` | string or null | Optional. Trimmed; a blank string is stored as `null`. |
| `category` | `GROCERIES`, `UTILITIES`, `RENT`, `MAINTENANCE`, `TRANSPORT`, `HEALTH`, `ENTERTAINMENT`, `OTHER` | Optional. Defaults to `OTHER`. |
| `paidById` | User ID | Optional on POST, where it defaults to the requester. Cannot be `null`. The user must belong to the household, otherwise `400` `Payer must be a member of this household`. |
| `taskId` | Task ID or null | Optional. The task must belong to the same household, otherwise `400` `Task must belong to this household`. |

PATCH accepts any subset of these fields and changes only what is sent. Send `null` to clear `description` or `taskId`. A PATCH containing none of these fields returns `400`. Unknown properties are ignored everywhere. The household comes from the URL and the recorder from the token, so `householdId`, `createdById`, and `id` in a body are ignored.

### Response shape

`amount` is always a string with two decimal places, because the column is `numeric(12, 2)` and a JSON number could not represent it exactly. `task` is `null` for a standalone expense.

```json
{
  "message": "Expense fetched successfully",
  "expense": {
    "id": "expense-id",
    "householdId": "household-id",
    "amount": "1250.50",
    "description": "Weekly groceries",
    "category": "GROCERIES",
    "createdAt": "2026-09-10T07:00:00.000Z",
    "updatedAt": "2026-09-10T07:00:00.000Z",
    "paidBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null },
    "createdBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null },
    "task": { "id": "task-id", "title": "Buy groceries", "status": "DONE" }
  }
}
```

### Listing, filtering, and pagination

The list endpoint accepts optional query parameters:

| Parameter | Type | Default | Rules |
| --- | --- | --- | --- |
| `category` | one of the category values | none | Return only expenses in this category. |
| `paidById` | User ID | none | Return only expenses this user paid. |
| `taskId` | Task ID | none | Return only expenses linked to this task. |
| `from` | ISO 8601 string | none | Return only expenses created at or after this instant. |
| `to` | ISO 8601 string | none | Return only expenses created at or before this instant. Must not be before `from`, otherwise `400` `From must not be after to`. |
| `page` | integer | 1 | 1-based page number, at most 100000. |
| `limit` | integer | 20 | Expenses per page, 1 to 100. |

Example: `GET /api/households/:householdId/expenses?category=GROCERIES&from=2026-09-01&to=2026-09-30T23:59:59.999Z&page=2&limit=10`. Values must be plain digits, an exact category name, a parseable date, or a non-blank ID. Anything else, including a repeated parameter, returns `400` with the rule in the message.

Expenses are ordered by creation time (newest first), then ID, so pages stay stable while nothing changes. Each entry has the expense shape shown above, and the response adds the page details:

```json
{
  "message": "Expenses fetched successfully",
  "expenses": [{ "id": "expense-id", "amount": "1250.50", "category": "GROCERIES" }],
  "pagination": { "page": 2, "limit": 10, "total": 23, "totalPages": 3 }
}
```

`total` counts every expense matching the filter, not only those on the page, and `totalPages` is `0` when nothing matches.

### Summary

`GET /api/households/:householdId/expenses/summary` accepts the same filters as the list, minus `page` and `limit`, and returns totals computed by Postgres on the numeric column. Groups are ordered by total, largest first. With nothing matching, `total` is `"0.00"`, `count` is `0`, and both arrays are empty.

```json
{
  "message": "Expense summary fetched successfully",
  "summary": {
    "total": "3450.00",
    "count": 3,
    "byCategory": [
      { "category": "GROCERIES", "total": "2200.25", "count": 2 },
      { "category": "RENT", "total": "1249.75", "count": 1 }
    ],
    "byPayer": [
      { "paidBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null }, "total": "3450.00", "count": 3 }
    ]
  }
}
```

### Permissions

| Action | OWNER / ADMIN | MEMBER who recorded or paid the expense | Other MEMBER |
| --- | --- | --- | --- |
| List, view, and summary | Yes | Yes | Yes |
| Create | Yes | Yes | Yes |
| Update | Yes | Yes | No |
| Delete | Yes | Yes | No |

Both the recorder and the payer can manage an expense, since someone may log a bill their partner paid and either of them may need to correct it. A member with no relation to the expense receives `403` `You can only manage expenses you recorded or paid`.

### Errors

Errors use `{ "message": "..." }`: `400` for invalid input, a non-member payer, or a task from another household, `401` for missing or invalid authentication, `403` for prohibited updates and deletes, `404` `Household not found or access denied` for missing or inaccessible households, `404` `Expense not found` for a missing expense in an accessible household, `404` `Household, member, task, or expense no longer exists` when a referenced row disappears mid-write, `409` `Expenses changed concurrently; please retry` after three serialization retries, and `500` `Expense operation failed` for unexpected failures.

Expense operations run in serializable transactions with the same retry behavior as tasks, through the shared wrapper in `src/lib/transaction.ts`. This module requires the `add_expense` migration:

```sh
npx prisma migrate deploy
npx prisma generate
```

Expense HTTP tests in `tests/expense.test.mjs` cover authentication, household access, list filtering including date ranges and pagination, the summary's database aggregation and payer lookup, amount validation and normalization, payer membership and task household checks, every role and ownership combination for update and delete, null clearing, missing expenses, and simulated transaction conflicts. They mock Prisma.

## Images

Tasks and expenses can carry up to 5 photos each. Files live in Cloudinary; Postgres stores only the Cloudinary public ID and what Cloudinary reported about the file. The app uploads straight to Cloudinary with a signature the server issues, so image bytes never pass through this API and the Cloudinary secret never leaves the server.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| POST | `/api/households/:householdId/uploads` | None | 201 `{ message, upload }` |
| POST | `/api/households/:householdId/tasks/:taskId/images` | `{ "publicId", "width", "height", "bytes", "format" }` | 201 `{ message, task }` |
| DELETE | `/api/households/:householdId/tasks/:taskId/images/:imageId` | None | 200 `{ message, task }` |
| POST | `/api/households/:householdId/expenses/:expenseId/images` | Same as for tasks | 201 `{ message, expense }` |
| DELETE | `/api/households/:householdId/expenses/:expenseId/images/:imageId` | None | 200 `{ message, expense }` |

### Upload flow

1. `POST /uploads` as any member of the household. The response is a ticket:

```json
{
  "message": "Upload authorized",
  "upload": {
    "uploadUrl": "https://api.cloudinary.com/v1_1/<cloud>/image/upload",
    "fields": {
      "timestamp": "1789000000",
      "public_id": "homehub/households/<householdId>/<uuid>",
      "asset_folder": "homehub/households/<householdId>",
      "allowed_formats": "jpg,jpeg,png,webp,heic,heif",
      "transformation": "c_limit,w_2000,h_2000",
      "api_key": "…",
      "signature": "…"
    },
    "publicId": "homehub/households/<householdId>/<uuid>",
    "allowedFormats": ["jpg", "jpeg", "png", "webp", "heic", "heif"],
    "expiresAt": "…"
  }
}
```

2. Send a multipart form to `uploadUrl` with every entry of `fields` exactly as given plus a `file` part. Cloudinary checks the signature (SHA-256 over the signed fields and the secret), refuses other formats, shrinks anything over 2000 pixels a side, and stores the file at `public_id`. Changing any signed field makes Cloudinary answer `401`. A ticket is good for one hour and one public ID.
3. Post Cloudinary's reply to the task or expense: `publicId` (must equal the ticket's), `width`, `height`, `bytes` and `format`. The server checks that the public ID sits in the household's own folder, that it is not already attached, and that the parent has fewer than 5 images. The full task or expense comes back, images included.

### Image shape

Every task and expense response now includes `images`, oldest first:

```json
"images": [
  {
    "id": "image-id",
    "url": "https://res.cloudinary.com/<cloud>/image/upload/f_auto,q_auto/homehub/households/<householdId>/<uuid>",
    "thumbnailUrl": "https://res.cloudinary.com/<cloud>/image/upload/c_fill,g_auto,w_400,h_400,f_auto,q_auto/homehub/households/<householdId>/<uuid>",
    "width": 1600,
    "height": 1200,
    "bytes": 345678,
    "format": "jpg",
    "createdAt": "2026-09-10T12:00:00.000Z",
    "uploadedBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": null }
  }
]
```

Delivery URLs are public: anyone holding the exact link can view the image, and the random UUID is what keeps them unguessable. `f_auto,q_auto` lets Cloudinary pick the format and quality per device.

### Permissions

| Action | Who |
| --- | --- |
| Request an upload ticket | Any member |
| Add or remove a task image | Owners, admins, the task's creator, and its assignee, the same people who may change its status |
| Add or remove an expense image | Owners, admins, and whoever recorded or paid the expense |

Refusals are `403` `You can only manage images on tasks you created or are assigned to` and `403` `You can only manage expenses you recorded or paid`.

### Deletion

Removing an image, deleting a task, or deleting an expense removes the rows inside the transaction and then asks Cloudinary to destroy the files. That call is best-effort: a Cloudinary failure is logged and never fails the request, so a file can occasionally outlive its row. Deleting a task keeps its expenses and their images.

### Errors

`400` for an invalid body, a public ID outside the household's folder (`Image does not belong to this household`), or a full parent (`At most 5 images can be attached`), `409` `This image is already attached`, `404` `Image not found`, and `503` `Image uploads are not configured on this server` when `CLOUDINARY_URL` is missing.

### Configuration

Set `CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>` in `.env` (and on the host when deploying). No upload preset is needed; the server signs the format and size policy itself. This module requires the `add_image` migration, which also adds a check constraint so an image belongs to exactly one task or one expense:

```sh
npx prisma migrate deploy
npx prisma generate
```

Image HTTP tests in `tests/image.test.mjs` cover the ticket's fields and signature, folder checks, duplicate and limit rules, every role and ownership combination for tasks and expenses, body validation, and the Cloudinary cleanup after removals and parent deletes, with the Cloudinary SDK mocked.

## Profile pictures

A user can have one profile picture and a household can have one picture. Both use the same direct-to-Cloudinary flow as [Images](#images): ask for a ticket, upload the file to Cloudinary, then tell the API which file to use.

| Method | Path | Who | Body | Success |
| --- | --- | --- | --- | --- |
| GET | `/api/users/me` | Signed-in user | None | 200 `{ message, user }` |
| POST | `/api/users/me/avatar/uploads` | Signed-in user | None | 201 `{ message, upload }` |
| PUT | `/api/users/me/avatar` | Signed-in user | `{ "publicId" }` | 200 `{ message, user }` |
| DELETE | `/api/users/me/avatar` | Signed-in user | None | 200 `{ message, user }` |
| POST | `/api/households/:householdId/picture/uploads` | OWNER, ADMIN | None | 201 `{ message, upload }` |
| PUT | `/api/households/:householdId/picture` | OWNER, ADMIN | `{ "publicId" }` | 200 `{ message, household }` |
| DELETE | `/api/households/:householdId/picture` | OWNER, ADMIN | None | 200 `{ message, household }` |

`me` is always the user in the token, so no route can name another person. `upload` is the same ticket shape as for images. `publicId` is the ticket's `publicId`, sent back after Cloudinary accepted the file.

### Where the picture appears

Every user object in this API now has `avatarUrl`, which is `null` until a picture is set:

```json
{ "id": "user-id", "name": "Praveen", "email": "praveen@example.com", "avatarUrl": "https://res.cloudinary.com/<cloud>/image/upload/c_fill,g_face,w_400,h_400,f_auto,q_auto/homehub/users/<userId>/<uuid>" }
```

That covers the `user` from register, login, Google sign-in and `/users/me`, household members, invitation senders and recipients, task and expense people, and image uploaders. Chat senders and participants are `{ id, name, avatarUrl }` without the email, and the same object travels in the `chat:message` socket event. All of these read one shared field list in `src/lib/user-select.ts`, so a person looks the same everywhere.

A household carries `pictureUrl` in `GET /api/households`, in the `household` returned by the picture routes (`{ id, name, createdAt, pictureUrl, role }`, the same shape as a list entry), and in the `household` of an invitation.

### How pictures are stored and delivered

- Avatars are uploaded to `homehub/users/<userId>/<uuid>`, household pictures to `homehub/households/<householdId>/picture/<uuid>`. The folder contains the owner's ID, so the server can refuse a file that was signed for someone else (`400`). A household picture sits one level below the household's photos, so it can never be attached to a task or expense, and a photo can never become a picture. Chat photos follow the same rule one level further down, in `homehub/households/<householdId>/chat/<conversationId>/<uuid>` (see [CHAT.md](CHAT.md#photos)).
- Every upload gets a new random ID, so a changed picture has a new URL and no phone keeps showing the old one from its cache.
- Postgres stores two columns per owner: the public ID, which Cloudinary needs to delete the file, and the delivery URL, ready to show. The URL is stored instead of being built on every read because a person appears nested inside many other records.
- Cloudinary crops on delivery to a 400 pixel square. Avatars use `g_face`, which keeps the face in the middle even when the upload was not square. Household pictures use `g_auto`.
- Setting a new picture or removing one deletes the previous Cloudinary file after the database change is committed. As with images, that call is best-effort.
- The URL is unguessable but public, like task and expense photos. Someone who leaves a household keeps any URL their phone already loaded.

### Errors

`400` `Image public ID is required`, `Image does not belong to this account` or `Image does not belong to this household`. `401` without a valid token, and `Account no longer exists` when the token's user was deleted. `403` `Only owners and admins can change the household picture`. `404` `Household not found or access denied` for a nonmember. `503` when `CLOUDINARY_URL` is missing.

This module requires the `add_profile_pictures` migration, which adds four nullable columns and needs no backfill:

```sh
npx prisma migrate deploy
npx prisma generate
```

`tests/profile-picture.test.mjs` covers the shared user fields, the folder rules, authentication on every route, the profile, tickets, set, replace and remove for both owners, every household role, and the Cloudinary cleanup, with the Cloudinary SDK mocked.

## Forgot password

A person who cannot sign in asks for a code by email, then sends the code with a new password. Codes are six digits, live for 15 minutes, and die after five wrong tries or once used. Only the SHA-256 hash of a code is stored.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| POST | `/api/auth/forgot-password` | `{ "email": "praveen@example.com" }` | 200 `{ message }` |
| POST | `/api/auth/reset-password` | `{ "email": "praveen@example.com", "code": "123456", "password": "new-password" }` | 200 `{ message }` |

### Request a code

`POST /api/auth/forgot-password` always answers `200` `If that email is registered, a reset code is on its way`, whether or not the address has an account, so the endpoint cannot be used to discover who is registered. When the address is registered, any earlier code is retired, a fresh one is stored as a hash with a 15-minute expiry, and an email is sent:

```
Hi Praveen,

Your HomeHub password reset code is:

482913

Enter it in the app within 15 minutes. If you did not ask to reset your password, you can ignore this email and your password will stay as it is.
```

A second request within 60 seconds of the last gets the same `200` but sends nothing. If the mail cannot be sent, the response is `503` `Could not send the email. Please try again later.` and the unsent code is retired so the next request is not blocked by the cooldown.

### Reset with the code

`POST /api/auth/reset-password` checks, in order, that the email is well formed, the code is exactly six digits, and the password is 8 to 72 characters. Each failure returns `400` with the rule in the message. Then the live code for the account is compared in constant time. On success the password is stored as a bcrypt hash, the code is marked used, and the response is `200` `Password updated. You can sign in with your new password.`

Every other case answers `400` `Invalid or expired code`: an unknown email, no code issued, an expired code, a used code, a code past its five attempts, or a wrong code. A wrong code counts against the code's attempts even though the request fails; a code with five wrong attempts is dead and a new one must be requested.

Existing sign-in tokens stay valid until they expire (seven days). Signing other devices out on reset is a follow-up.

### Configuration

Set `EMAIL_USER` to a Gmail address and `EMAIL_PASS` to a 16-character App Password from that Google account (Security, 2-Step Verification, App passwords). Mail goes out through Gmail's SMTP as `HomeHub <address>`. With neither set, the backend prints the email to its console instead of sending, so the flow works locally without an account. This module requires the `add_password_reset` migration:

```sh
npx prisma migrate deploy
npx prisma generate
```

Tests in `tests/password-reset.test.mjs` cover code generation, validation, the identical response for unknown emails, the cooldown, mail failure, the successful reset with a bcrypt hash, wrong-code counting, and every refusal case, with Prisma and the mailer mocked.


## Notifications

All notification endpoints require `Authorization: Bearer <token>`. The token identifies the recipient; passing a user ID in the body or query cannot change whose inbox is accessed. These endpoints work across all of that user's households, including historical notifications after membership ends.

| Method | Path | Success (200) |
| --- | --- | --- |
| GET | `/api/notifications` | `{ message, notifications, pagination }` |
| GET | `/api/notifications/unread-count` | `{ "unreadCount": 3 }` |
| PATCH | `/api/notifications/:id/read` | `{ "message": "Notification marked as read" }` |
| PATCH | `/api/notifications/read-all` | `{ "message": "Notifications marked as read", "updatedCount": 3 }` |
| DELETE | `/api/notifications/:id` | `{ "message": "Notification deleted successfully" }` |

PATCH and DELETE require no body. Marking an already-read notification succeeds. Mark-all updates only currently unread notifications and returns the number changed (zero is valid). Deleting an already-deleted notification returns 404.

### Pagination and filtering

`GET /api/notifications?page=1&limit=20&unread=true`

- `page`: integer from 1 to 100000, default 1.
- `limit`: integer from 1 to 100, default 20.
- `unread`: optional exact `true` (unread only) or `false` (read only). Omit it for both.
- Invalid or repeated values for these parameters return 400.
- Notifications are ordered by `createdAt` descending, then `id` descending. An empty inbox returns an empty array and `totalPages: 0`.

```json
{
  "message": "Notifications fetched successfully",
  "notifications": [{
    "id": "notification-id",
    "userId": "recipient-id",
    "type": "TASK_ASSIGNED",
    "title": "New task assigned to you",
    "message": "Praveen assigned you a task: Buy groceries",
    "isRead": false,
    "householdId": "household-id",
    "entityId": "task-id",
    "createdAt": "2026-09-19T10:00:00.000Z"
  }],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`householdId` and `entityId` are the navigation target and may each be `null`. `entityId` is a task ID for `TASK_*` types and an expense ID for `EXPENSE_*` types, and the invitation ID for `HOUSEHOLD_INVITATION`; `MEMBER_JOINED` and `INVITATION_DECLINED` have a `householdId` only. `entityId` has no foreign key, so the task or expense may have been deleted since: treat a 404 when opening it as "no longer available". `householdId` becomes `null` if the household is deleted. Check membership before navigating, because the recipient may have left the household.

Missing and another user's notification IDs both return 404 `Notification not found`. Invalid/missing tokens return 401. Unexpected failures return 500 `Notification operation failed` without exposing database details.

### Postman / Thunder Client walkthrough

1. Log in and put the returned token in Authorization > Bearer Token.
2. Call GET `/api/notifications` and GET `/api/notifications/unread-count`. Without seeded notifications, expect an empty list and zero.
3. For a populated test, create a notification for an existing test user's ID through the internal `createNotification()` service or Prisma Studio. There is no public POST endpoint. Task and expense operations now create notifications automatically; see the event rules below.
4. Copy the notification ID from the list. PATCH `/api/notifications/<id>/read`; verify unread count decreases and repeating the PATCH succeeds.
5. Try the list with `unread=true`, `unread=false`, and `page=1&limit=1`.
6. PATCH `/api/notifications/read-all`; verify unread count is zero.
7. DELETE `/api/notifications/<id>`; verify it disappears. Repeating the deletion returns 404.
8. Log in as a second user: the first user's notifications must be absent, and read/delete requests for their IDs must return 404.

The `add_notifications` and `add_notification_target` migrations must be applied to the target database. Automated HTTP tests mock Prisma; they do not establish live PostgreSQL migration or connectivity status.


### Automatic task and expense notifications

Notifications are created by backend services, with no frontend POST needed.

| Type | Trigger | Recipient |
| --- | --- | --- |
| `TASK_ASSIGNED` | Create an assigned task, or change its assignee | New assignee, unless they performed the action |
| `TASK_COMPLETED` | Change an existing task from another status to `DONE` | Task creator, if still a household member and not the actor |
| `EXPENSE_ADDED` | Create an expense | All current household members except the actor |
| `EXPENSE_UPDATED` | Change amount, description, category, payer, or linked task | All current household members except the actor |

An unchanged assignment, clearing an assignment, self-assignment, and repeated `DONE` updates produce no notification. Reopening a completed task and completing it again is a new completion event. Creating a task already marked DONE does not generate a completion notice. Equivalent amounts such as 850 and 850.00 do not count as a change. Image-only edits and deletion do not generate notices.

Expense messages identify the payer, who may differ from the person recording the expense. Amounts have two decimal places without an assumed currency. Messages use the current task title or updated expense details.

Task and invitation messages name the person who acted, read from their account when the notification is written: `Praveen assigned you a task: Buy groceries`, `Asha completed your task: Buy groceries`. The name is stored as text, so a later rename does not change old notifications.

Notification types are validated in TypeScript and at runtime; the database column remains text. `MEMBER_REMOVED` is a reserved type; its event producer is not connected yet.

All notification inserts use the same transaction as the task or expense write. A failed insert aborts the whole operation. Serialization retries retry both together. This does not provide request-level idempotency for repeated POST requests: each successful POST creates a separate resource and notifications.

To test: as user A create a task assigned to B; sign in as B and check the inbox. Have B mark it DONE and check A's inbox. Repeat the same status PATCH and verify no extra notice. Create/update an expense as A and check the inbox of another current member; repeat an identical update and verify no extra notice. The automatic tests mock Prisma, including transaction failure/retry paths; actual PostgreSQL rollback behavior is not exercised by them.

These are stored in-app notifications. Expo push delivery is not yet connected. Each notification carries `householdId` and `entityId` for navigation; rows created before the `add_notification_target` migration have both as `null`.


### Invitation notifications

Inviting, accepting and declining each notify one person; see **Household invitations** for the table. `entityId` on a `HOUSEHOLD_INVITATION` notification is the invitation ID.


## Google sign-in and account linking

Email/password registration, login, and password reset remain available for accounts with a local password. Google-only users have a null password and use Google to sign in. Password-reset requests for them return the usual generic message without emailing a code; reset attempts fail with `Invalid or expired code`.

### Backend setup

1. Create the Google OAuth client configuration for your Expo app. Request the `openid`, `email`, and `profile` scopes. Configure the Expo native sign-in library's `webClientId` to the Web OAuth client ID used for backend authentication.
2. Add the expected ID-token audience to the backend `.env`:

```dotenv
GOOGLE_CLIENT_IDS=your-web-client-id.apps.googleusercontent.com
```

Use a comma-separated allowlist only if multiple trusted clients intentionally issue tokens for this backend. Never accept arbitrary audiences from clients. No Google client secret is needed for this ID-token verification flow. Existing `JWT_SECRET` and `DATABASE_URL` configuration still apply.

3. Apply the migration and regenerate the client:

```sh
npx prisma migrate deploy
npx prisma generate
```

The `add_google_auth` migration adds a unique nullable `googleId` and makes `password` nullable. It does not remove existing users or change existing password hashes. `migrate deploy` applies all pending migrations, so review pending migration status for the target environment first. Restart the backend after configuring it.

Without `GOOGLE_CLIENT_IDS`, Google endpoints return 503 `Google sign-in is not configured`; ordinary authentication continues to work.

### Sign up or sign in with Google

`POST /api/auth/google` (no HomeHub token required):

```json
{ "idToken": "<Google ID token obtained by the Expo app>" }
```

Use an ID token, not a Google access token. Send it over HTTPS in deployed environments. The server uses Google's official library to verify the signature, issuer, audience, and expiry, then requires a verified email. Name, email, and Google account ID are taken from the verified token, never from separate request fields.

- Existing `googleId`: 200, signs into that same HomeHub user. A changed Google email does not overwrite the saved HomeHub email.
- New Google ID and unused email: 201, creates a Google-only account.
- Email already belongs to any existing account (case-insensitive comparison): 409 `Sign in to your existing account first, then link Google`. No automatic merging or linking occurs.

```json
{
  "message": "Login successful",
  "user": { "id": "user-id", "name": "Alice", "email": "alice@gmail.com", "avatarUrl": null },
  "isNewUser": false,
  "token": "<HomeHub JWT>"
}
```

For a new user, the message is `Account created successfully` and `isNewUser` is true. Use the returned HomeHub JWT for all protected APIs as before. Google ID tokens are not stored. No Gmail mailbox permissions are requested.

### Link Google to an existing password account

First log in using the existing email and password. Then call `POST /api/auth/google/link` with `Authorization: Bearer <HomeHub JWT>`:

```json
{
  "idToken": "<Google ID token>",
  "password": "<current HomeHub password>"
}
```

The authenticated user comes from the HomeHub JWT, not the body. Linking requires the current password and a verified Google email matching the HomeHub email (ignoring case). A Google account cannot belong to two HomeHub users, and this endpoint cannot replace a different Google account already linked. Repeating a successful link to the same account is allowed.

Success: 200 `{ "message": "Google account linked successfully", "user": { "id", "name", "email", "avatarUrl" } }`.

Linking preserves the user ID, password, memberships, tasks, expenses, and notifications. Afterwards both login methods work. Unlinking, changing the account email, and adding a password to a Google-only account are not implemented.

### Errors and testing

- 400: missing/invalid token input or missing current password for linking.
- 401: invalid/expired Google token, unverified/missing email, invalid current password, or invalid HomeHub authentication for linking.
- 409: an existing account needs explicit linking, mismatched email, an already-linked Google identity, or a concurrent account conflict.
- 503: missing Google client ID configuration.
- 500: unexpected server error, with no internal details returned.

In Postman or Thunder Client, copy a fresh Google ID token from your development app and call `/api/auth/google`. Confirm new account creation, then repeat to confirm login uses the same user ID. For an existing password account, confirm 409 first, log in normally, link with both credentials, then verify both login methods return the same user ID. Confirm the HomeHub JWT works for `/api/notifications` or `/api/households`.

Automated Google-auth tests use real RSA-signed test tokens with local test certificates to exercise Google's verification library without a network request. Database calls are mocked. Live Google OAuth configuration and PostgreSQL migrations must be verified separately in the target environment.

References: [Google backend token verification](https://developers.google.com/identity/sign-in/web/backend-auth), [Expo Google authentication setup](https://docs.expo.dev/guides/google-authentication/).
