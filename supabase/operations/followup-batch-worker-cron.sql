-- Stage 1 cron: TEST MODE only. This worker refuses calls without both the
-- shared secret and x-recruiting-test-mode: true, and its database RPC only
-- claims batches whose mode is 'test'. All recipients are fixed to fujitame@gmail.com.
-- In Supabase Dashboard:
-- 1) Enable pg_cron and pg_net.
-- 2) Set Edge Function secret FOLLOWUP_BATCH_WORKER_SECRET to a new random value.
-- 3) Add Vault secrets named:
--      followup_batch_worker_url    = https://cjrabdfdtrufbpjmqddh.supabase.co/functions/v1/recruiting-gmail-followup-batch-worker
--      followup_batch_worker_secret = same random value as the Edge Function secret
-- 4) Run once after deploying the test-only migration and functions.
-- Do not use this setup for production schools; production support is a later release.

select cron.schedule(
  'recruiting-followup-batch-test-worker',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='followup_batch_worker_url'),
    headers := jsonb_build_object(
      'content-type','application/json',
      'x-recruiting-test-mode','true',
      'x-recruiting-batch-worker-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='followup_batch_worker_secret')
    ),
    body := '{}'::jsonb
  );
  $job$
);
