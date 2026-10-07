-- Follow-up batch worker: install only after setting the matching Edge Function secret.
-- In Supabase Dashboard:
-- 1) Enable pg_cron and pg_net extensions.
-- 2) Add Edge Function secret FOLLOWUP_BATCH_WORKER_SECRET with a new random value.
-- 3) Add Vault secrets named:
--      followup_batch_worker_url    = https://cjrabdfdtrufbpjmqddh.supabase.co/functions/v1/recruiting-gmail-followup-batch-worker
--      followup_batch_worker_secret = the exact same random value as the Edge Function secret
-- 4) Run this SQL once. It invokes the worker every minute; the worker claims only due items.
-- Do not put secret values in the repository or run this against a project before deployment.

select cron.schedule(
  'recruiting-followup-batch-worker',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'followup_batch_worker_url'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-recruiting-batch-worker-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'followup_batch_worker_secret')
    ),
    body := '{}'::jsonb
  );
  $job$
);
