# Task reminders

Personal reminders are independent of task assignment: any current household member
can set one reminder for themselves per task. The API never accepts a recipient ID.
The feature uses the existing PostgreSQL database and Expo push setup, without new
npm dependencies, Redis, or BullMQ. Supabase Cron triggers processing through a
protected backend endpoint; there is no reminder timer in the Node server.

## API

All endpoints require the existing Bearer token and household membership.

`GET /api/households/:householdId/tasks/:taskId/reminder`

Returns `{ "reminder": null }` when the user has no reminder, otherwise their saved
reminder. Fields include `id`, `taskId`, `repeat`, `timeZone`, `localTime`,
`nextRunAt`, `enabled`, `createdAt`, and `updatedAt`. Dates are UTC ISO strings.

`PUT /api/households/:householdId/tasks/:taskId/reminder`

Creates or replaces the caller's reminder and returns `{ "message": "Reminder saved",
"reminder": ... }` with HTTP 200. This is a complete replacement, not a PATCH.

One-time example:

```json
{
  "repeat": "ONCE",
  "timeZone": "Asia/Kolkata",
  "remindAt": "2026-12-01T09:00:00+05:30"
}
```

`remindAt` must be in the future and include `Z` or a numeric offset. Its timestamp
defines the exact instant; `timeZone` records the user's display preference.

Daily example:

```json
{
  "repeat": "DAILY",
  "timeZone": "Asia/Kolkata",
  "localTime": "09:00"
}
```

`timeZone` must be a supported IANA timezone. `localTime` is a 24-hour `HH:mm` string.
The next occurrence is strictly after the time of saving. A daily reminder is for
the same task; it does not create tasks or reset their status. The saved zone stays
fixed when travelling until the preference is changed. DST gaps skip that day's
nonexistent time; a repeated time uses its first occurrence only.

`DELETE /api/households/:householdId/tasks/:taskId/reminder`

Removes the caller's reminder and queued deliveries. Repeated deletion succeeds.
Returns `{ "message": "Reminder removed" }` with HTTP 200.

Completed tasks reject new reminders with HTTP 400. Missing tasks and inaccessible
households return 404; missing authentication returns 401. Invalid input returns 400.

## Processing flow

1. Save a reminder in `TaskReminder`. Updating it increments its version, invalidating
   old queued pushes.
2. Supabase Cron calls `POST /api/internal/task-reminders/run` every minute with
   a dedicated Bearer secret. The endpoint processes a bounded batch: up to 100
   reminders and 50 delivery jobs, with a soft 20-second processing budget. Work
   already started may finish after that budget. Schedules persist across restarts.
3. A transaction locks a due row with `FOR UPDATE SKIP LOCKED`, checks the current
   task and membership, creates a `TASK_REMINDER` inbox entry and a delivery row per
   registered device, then advances the schedule. All those writes commit together.
4. One-time reminders become disabled with `nextRunAt: null`. Daily reminders advance
   to the next local occurrence. After downtime, each due reminder emits at most one
   catch-up notification, then advances past the missed dates.
5. The same cron invocation processes the push queue when `EXPO_PUSH_ENABLED=true`.
   Jobs use expiring leases, bounded retries with backoff, Expo tickets and receipt
   checks. Expired device tokens are deleted. Unsent pushes expire after one hour
   from queue creation; the inbox notification remains available. Retries whose
   backoff has elapsed run on a later cron invocation, rather than a Node timer.
6. Completing a task disables all its reminders and invalidates queued pushes in
   the task transaction. Reopening does not enable them again. Task deletion cascades
   reminders; household-member deletion cascades that member's reminders, even if
   they later rejoin. Delivery checks current task status and device ownership again.

Inbox creation is transactional and protected from concurrent schedule workers.
Push delivery is at least once: a crash after Expo accepts a push but before its ticket
is saved may cause a duplicate on retry. `notificationId` is included for frontend
deduplication. A push already accepted by Expo cannot be recalled after cancellation.

The push payload is a standard OS-rendered notification with title `Task reminder`,
the task title as its body, and data:

```json
{
  "type": "TASK_REMINDER",
  "householdId": "...",
  "taskId": "...",
  "notificationId": "...",
  "recipientId": "..."
}
```

This deliberately avoids Android's chat-only background action pipeline.

## Render setup

1. Generate a new secret locally (do not use your JWT secret or a Supabase API key):

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. In Render's service Environment settings, set `TASK_REMINDER_CRON_SECRET` to
   that generated value (at least 32 characters, no whitespace). Keep it out of
   source control and the frontend. Missing/invalid configuration returns HTTP 503;
   incorrect/missing Bearer credentials return HTTP 401.
3. Keep your existing Expo configuration. Set `EXPO_PUSH_ENABLED=true` to send pushes
   and configure `EXPO_ACCESS_TOKEN` if your Expo project requires it.
4. Apply the migration below and deploy the backend before enabling the cron job.

Apply the committed migration to the intended database before starting the new
server version:

```sh
npm run migrate:deploy
npm run build
npm start
```

No additional Prisma migration is needed specifically to switch the trigger to
Supabase Cron. The task-reminder tables introduced by this feature are still required.

## Supabase setup

1. In the Supabase Dashboard, enable **Integrations → Cron** (`pg_cron`) and enable
   the `pg_net` extension. The setup SQL also includes `CREATE EXTENSION IF NOT EXISTS`.
2. In **Vault**, add these two named secrets:

   | Name | Value |
   | --- | --- |
   | `homehub_backend_url` | Your Render HTTPS origin, e.g. `https://your-service.onrender.com` (no `/api` suffix) |
   | `homehub_task_reminder_cron_secret` | The exact value of Render's `TASK_REMINDER_CRON_SECRET` |

3. Open `supabase/task-reminder-cron.sql` from this repository and run it in the
   Supabase SQL Editor as `postgres`. It validates the Vault configuration and
   creates/updates `homehub-task-reminders` on `* * * * *` (every minute). It also
   creates a daily job to prune only this feature's cron history after seven days.
   The SQL contains only Vault lookups, never your actual secret. Re-running it
   updates the named jobs rather than adding duplicate schedules.
4. Inspect the job in **Integrations → Cron**. Also check the HTTP results using
   the query below: cron's success means the HTTP request was queued, not that
   the backend processed it successfully.

   ```sql
   select id, status_code, timed_out, error_msg, content, created
   from net._http_response
   order by created desc
   limit 20;
   ```

   These are recent HTTP responses from all `pg_net` callers; identify this endpoint
   by its response message. Responses are normally retained for six hours.

The job's request timeout is 120 seconds to allow a Render cold start plus processing.
The endpoint waits for the batch to finish before replying. Example HTTP 200 body:

```json
{
  "message": "Task reminder batch processed",
  "remindersProcessed": 1,
  "deliveriesProcessed": 2,
  "pushEnabled": true,
  "batchLimitReached": false
}
```

`deliveriesProcessed` counts queue attempts, including cancellations, retries and
receipt checks; it is not a count of alerts confirmed visible on phones.
`batchLimitReached: true` means more work may remain for the next invocation.

Test manually from PowerShell after assigning the secret to the local environment:

```powershell
Invoke-RestMethod -Method Post `
  -Uri 'https://YOUR-SERVICE.onrender.com/api/internal/task-reminders/run' `
  -Headers @{ Authorization = "Bearer $env:TASK_REMINDER_CRON_SECRET" }
```

A user login JWT cannot invoke this endpoint. UptimeRobot should continue using
`GET /health`; it does not need the cron secret. No Supabase Edge Function is required.

For rotation, update the Render environment and the matching Vault secret together;
the cron command reads Vault on every run, so no schedule change is needed. Never
paste the real secret into repository SQL. As with any authenticated `pg_net` request,
database roles with access to the pending request queue can see its authorization
header; limit database access accordingly.

To pause/resume processing, change `active` for the reminder job:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'homehub-task-reminders'),
  active := false -- use true to resume
);
```

While paused, the reminder API still saves preferences, but nothing fires. Resuming
uses the single catch-up policy described above. The daily history cleanup can remain
enabled independently.

Setup references: [Cron quickstart](https://supabase.com/docs/guides/cron/quickstart),
[scheduling with Vault](https://supabase.com/docs/guides/functions/schedule-functions),
[pg_net responses](https://supabase.com/docs/guides/database/extensions/pg_net).

## Delivery limitations and frontend handoff

Use the existing Expo credentials, `EXPO_ACCESS_TOKEN` when required by the Expo
project, and `EXPO_PUSH_ENABLED=true`. With push disabled, inbox reminders still
work; jobs are queued but are not sent until enabled (subject to their expiry).
No devices registered means inbox delivery only. Completed jobs are retained seven
days; failed jobs thirty days; unsent jobs without tickets are removed after seven days.

Supabase Cron schedules independently of Render and its HTTP request can wake the
service. Render Free cold starts, downtime, network failures or a paused Supabase
project can still delay reminders. The next successful invocation resumes persisted
work. This is not an exact alarm; the schedule adds up to around a minute before
processing/delivery latency, with longer delays if the batch has a backlog. No
reminder timer or fallback scheduler starts from `src/server.ts`.

Frontend work is still required: add the Remind me dialog, call these endpoints,
request notification permission through the existing registration flow, add an inbox
icon for `TASK_REMINDER`, and extend native notification tap handling to open the task
after checking recipient/session and household access. The current native tap handler
only navigates chat alerts. Browser push is not implemented.

The task list/detail response is unchanged; fetch personal preferences through the
reminder endpoint. Real device push delivery must be verified with the frontend and
the deployed Expo credentials. Tests mock PostgreSQL and Expo; they do not certify
live database concurrency or handset delivery.
