-- Run in Supabase SQL Editor as postgres AFTER deploying the backend and adding
-- these Vault secrets (use the Dashboard Vault UI; don't commit actual values):
--   homehub_backend_url: https://YOUR-SERVICE.onrender.com (no /api suffix)
--   homehub_task_reminder_cron_secret: identical to Render TASK_REMINDER_CRON_SECRET
-- This is hosting configuration, not a Prisma migration. Safe to rerun: named
-- cron.schedule calls update existing jobs instead of duplicating them.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
declare
  backend_url text;
  cron_secret text;
begin
  select decrypted_secret into backend_url from vault.decrypted_secrets
    where name = 'homehub_backend_url';
  select decrypted_secret into cron_secret from vault.decrypted_secrets
    where name = 'homehub_task_reminder_cron_secret';
  if backend_url is null or backend_url !~ '^https://[^/[:space:]]+/?$'
      or backend_url like '%YOUR-SERVICE%' then
    raise exception 'Set Vault secret homehub_backend_url to your HTTPS backend origin';
  end if;
  if cron_secret is null or length(cron_secret) < 32 or cron_secret ~ '[[:space:]]' then
    raise exception 'Set Vault secret homehub_task_reminder_cron_secret (32+ characters, no whitespace)';
  end if;
end;
$$;

select cron.schedule(
  'homehub-task-reminders',
  '* * * * *',
  $job$
    select net.http_post(
      url := rtrim((select decrypted_secret from vault.decrypted_secrets
        where name = 'homehub_backend_url'), '/') || '/api/internal/task-reminders/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
          where name = 'homehub_task_reminder_cron_secret')
      ),
      body := '{}'::jsonb,
      -- Allow for Render Free cold starts plus the backend's bounded processing.
      timeout_milliseconds := 120000
    );
  $job$
);

-- Cron history is not pruned automatically. Keep only this feature's seven-day
-- history, leaving other applications' job records alone.
select cron.schedule(
  'homehub-reminder-cron-history-cleanup',
  '0 0 * * *',
  $job$
    delete from cron.job_run_details
    where jobid in (
      select jobid from cron.job where jobname in (
        'homehub-task-reminders', 'homehub-reminder-cron-history-cleanup'
      )
    ) and end_time < now() - interval '7 days';
  $job$
);

commit;
