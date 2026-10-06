# Follow-up batch reservation deployment

This feature is intentionally dormant until the migration, both Edge Functions, the manual sender update, and the protected Cron job are installed.

## Deployment order

1. Apply `supabase/migrations/202610070001_recruiting_followup_batch_schedule.sql`.
2. Set the Edge Function secret `RECRUITING_FOLLOWUP_BATCH_DISPATCH_SECRET` to a newly generated random value. Do not reuse the Gmail OAuth credentials.
3. Save the same random value in Supabase Vault under `recruiting_followup_batch_dispatch_secret`.
4. Deploy:
   - `recruiting-gmail-followup-batch-preview`
   - `recruiting-gmail-followup-batch-dispatch`
   - updated `recruiting-gmail-followup-send`
5. Add a one-minute Cron job only after the function secret and Vault secret are in place:

```sql
select cron.schedule(
  'recruiting-gmail-followup-batch-every-minute',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://cjrabdfdtrufbpjmqddh.supabase.co/functions/v1/recruiting-gmail-followup-batch-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-recruiting-secret',
        (select decrypted_secret
         from vault.decrypted_secrets
         where name = 'recruiting_followup_batch_dispatch_secret'
         limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);
```

6. Deploy the Dashboard branch to GitHub Pages after review.
7. Before creating any real batch, confirm preview times for a set of schools in different US time zones, then verify cancellation and reply suppression with a non-sending test plan.

## Safety behavior

- Only reviewed Follow-up #1 items can be reserved.
- Test universities (IDs 900–999 or `is_test`) are rejected by the database and dispatcher.
- Any CRM reply at a school suppresses all unsent batch items for that school.
- The dispatcher rechecks every coach's Gmail thread at send time. If a thread cannot be checked, it fails closed and does not send.
- An uncertain Gmail transport result is terminal and requires a manual Gmail check before any retry.
- A queued Contact is blocked from the normal individual Follow-up sender.
- The dispatcher does not resend failed or stale `sending` items automatically.

## Operational note

Do not add the Cron job or reserve a batch until all preceding deployment steps have succeeded. This branch has not been deployed to production.
