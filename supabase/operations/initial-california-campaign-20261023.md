# California initial outreach campaign — 2026-10-23
User authorized personalized first emails to newly added California D1/D2 schools and clarified HC/AC separately, shared inboxes once under the HC name.
- Bounded campaign: school IDs 107–126, 20 schools, 35 distinct school/inbox recipients.
- Schedule: 2026-10-23 08:00 America/Los_Angeles = 15:00 UTC = 2026-10-24 00:00 Asia/Tokyo.
- Worker claims 8 per minute, processes 4 concurrently, and refuses transport beyond the two-hour window.
- Sender OAuth and account were checked without sending email. Every transport rechecks CRM and prior sent Gmail messages.
- Queue inserts and reservation notes were committed together. Actual CRM contact_logged events and next Follow-up date are written only after Gmail confirms a stored body match.
- Same-address HC/AC share one message/thread/tracking record, with both CRM histories updated atomically.
- Sending uncertainty is held for manual reconciliation, never automatically retried.
- School-specific facts are sourced from official 2026 rosters or the Mountain West standings and saved in recruiting_program_research.
- Queue payloads and email bodies stay in the private database and are not committed here.
- The new queue has owner SELECT RLS; service-role-only inserts/claims/finalization. Public metrics endpoint only accepts unguessable tokens and fixed redirect targets.
- Initial stage and YouTube click fields extend existing engagement tracking. Existing Follow-up send paths are preserved.
- Opening signals are image fetches, not proof of reading. Video signals mean link access, not proof of playback/duration/completion. Known automated accesses are recorded separately.

## Verification
- Pure worker eligibility tests: campaign/school scope, shared contact identity, premature/expired window, changed state/reply, test-school exclusion.
- Production rollback transactions verified future jobs cannot be claimed, shared contact finalization/history, one Gmail message owner, duplicate finalization rejection, video signal deduplication and service-only RPC permissions. No test changes remained.
- Signed worker preflight returned correct sender and zero sends/claims.
- YouTube event HEAD returned fixed 302 to the current approved highlights.
- Security advisors returned only pre-existing findings; none on the new queue or RPCs.

## Operations
Inspect recruiting_initial_email_jobs for this campaign, including status/error_message/Gmail IDs. Reservation notes are visible in CRM.
To cancel before transport, an authorized operator can change scheduled jobs to cancelled and add a CRM note. Never reset processing/send_unknown blindly.
Cron job recruiting-initial-ca-20261023 calls the worker only while scheduled rows are due, using the existing Vault worker secret without copying it into source.
After all jobs are terminal, the job can be unscheduled; it already makes no HTTP call when no scheduled jobs remain.
