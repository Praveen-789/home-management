# HomeHub API

Documentation for the currently implemented endpoints.

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
    "email": "praveen@example.com"
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
    "email": "praveen@example.com"
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
| POST | `/api/households/:householdId/members` | `{ "email": "member@example.com", "role": "MEMBER" }` or `{ "userId": "existing-user-id", "role": "MEMBER" }` | 201 `{ message, member }` |
| PATCH | `/api/households/:householdId/members/:userId` | `{ "role": "ADMIN" }` | 200 `{ message, member }` |
| DELETE | `/api/households/:householdId/members/:userId` | None | 200 `{ message }` |

POST identifies the user to add by exactly one of `email` or `userId`. The email is trimmed and then matched exactly against the address the user registered with (case-sensitive, like login). Sending neither returns `400` `User ID or email address is required`; sending both returns `400` `Provide either a user ID or an email address, not both`; a blank value returns `400` `Email address is required` or `User ID is required`. An unregistered email or unknown ID returns `404` `User not found`. Permission checks run before the lookup, so a requester who may not assign the role learns nothing about whether the email is registered. POST defaults an omitted role to `MEMBER`. PATCH requires a role. Only `ADMIN` and `MEMBER` are assignable. IDs must be nonblank strings. Extra body properties are ignored. The `:userId` parameter is a User ID, not a membership ID.

GET returns:

```json
{
  "message": "Household members fetched successfully",
  "members": [
    {
      "id": "membership-id",
      "role": "OWNER",
      "user": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com" }
    }
  ]
}
```

Members are ordered by joining time, then membership ID. POST and PATCH return the same member fields. Passwords are never selected.

| Permission | OWNER | ADMIN | MEMBER |
| --- | --- | --- | --- |
| List members | Yes | Yes | Yes |
| Add MEMBER | Yes | Yes | No |
| Add ADMIN | Yes | No | No |
| Change MEMBER to ADMIN or ADMIN to MEMBER | Yes | No | No |
| Remove MEMBER | Yes | Yes | No |
| Remove ADMIN | Yes | No | No |
| Assign, demote, or remove OWNER | No | No | No |

An authorized update to the current role succeeds (including ADMIN updating a MEMBER to MEMBER). Self-removal is unsupported. DELETE removes membership only, not the user. Ownership transfer and invitations are outside these endpoints.

Errors use `{ "message": "..." }`: `400` for invalid input, `401` for invalid/missing authentication, `403` for prohibited management actions, `404` for missing targets or inaccessible households, `409` for duplicate membership or exhausted concurrency retries, and a generic `500` for unexpected failures. Missing and inaccessible households share `Household not found or access denied`.

Membership checks and operations run in serializable transactions. Conflicts retry the entire operation up to three attempts, re-reading permissions. The existing composite unique constraint also protects against simultaneous duplicate additions. No new migration is required for this module.

Member HTTP tests in `tests/household-member.test.mjs` cover role combinations, authentication, access restrictions, safe response fields, validation, missing targets, duplicate errors, and simulated transaction conflicts. They mock Prisma; they do not verify PostgreSQL concurrency behavior against a live database.

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
      "role": "OWNER"
    }
  ]
}
```

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
    "createdBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com" },
    "assignedTo": { "id": "other-user-id", "name": "Ravi", "email": "ravi@example.com" }
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
    "paidBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com" },
    "createdBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com" },
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
      { "paidBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com" }, "total": "3450.00", "count": 3 }
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
    "uploadedBy": { "id": "user-id", "name": "Praveen", "email": "praveen@example.com" }
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
