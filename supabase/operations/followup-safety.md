# Recruiting Follow-up reservations

The existing CRM opens **送信予約** on demand. Test Mode and production reservations are separate. Test schools 900–902 always route to fujitame@gmail.com. Production allows non-Test school IDs 1–900, currently 106 schools.

## Stages and Gmail labels

| CRM stage | Follow-up count | Next regular Follow-up | Gmail state label |
| --- | --- | --- | --- |
| Initial email sent / waiting | 0 | #1 | Recruiting/Waiting Coach |
| Marked as Follow-up due | 0 or 1 | #1 or #2 | Recruiting/Follow-up Due |
| Follow-up #1 sent / waiting | 1 | #2, normally seven local calendar days later | Recruiting/Waiting Coach |
| Follow-up #2 sent / no response | 2 | None | Recruiting/No Response |
| Coach reply received, awaiting our reply | unchanged | None; individual CRM AI reply | Recruiting/Needs Reply |
| Individual reply sent after Coach reply | unchanged | None; individual conversation workflow | Recruiting/Waiting Coach |

A shared HC/AC Gmail thread has one label. All associated contacts and conversation history determine it; an active waiting contact takes priority over another contact's completed #2. Gmail is read before label synchronization so a newly arrived reply takes priority over stale CRM data.

## Send protection

- Selection, preview, reservation RPC and worker enforce waiting statuses and counts 0 or 1.
- A reply to any Coach at the school blocks every regular Follow-up at that school.
- The worker reads all known school Gmail threads, then rechecks CRM immediately before sending.
- Manual regular Follow-ups use the same school reply gate and refuse contacts already owned by a reservation.
- Production sends preserve the original Gmail thread, subject and recipient snapshot. Changed data stops the reservation.
- #2 does not add Research personalization. #1 Research IDs are checked against unused verified facts.
- A second initial send cannot reset an existing contact's stage to zero.
- Uncertain send results remain `send_unknown`; no automatic resend occurs.
- `LABEL_SYNC_PENDING:` on a sent reservation is retried by the worker without sending another message.

## Verification

Run `node tests/followup-safety.cjs` with Node 24+. Gmail transport is mocked: no email is sent by this suite. It covers #1/#2 transitions, history, fixed Test routing, production threading, CRM/Gmail school replies, changed recipient/thread, existing reservations, shared-thread label priority and label-only retries.

Production DB scheduling/cancellation and exclusions were additionally verified inside transactions that were rolled back. Actual replied-school Gmail threads and CRM conversation history were compared; missing labels were corrected. Production delivery itself was not triggered as part of verification.
