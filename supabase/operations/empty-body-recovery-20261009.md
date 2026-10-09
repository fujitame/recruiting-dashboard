# Reservation body incident and recovery — 2026-10-09

## Confirmed impact

- Batch `7bbd4ddc-9c95-4618-9d36-50d2190bad24`: 66 production Follow-up #1 items, sent on October 8–9 Japan time.
- Gmail message IDs were matched to all 66 reservation items. Every message had an empty snippet, zero-byte plain-text body and no child MIME parts. Reservation bodies were present in the database (312–326 characters).
- The deployed MIME builder filtered the entire message array with `filter(Boolean)`, removing the mandatory empty line between headers and body. Gmail accepted the sends, while CRM counts and history advanced without verifying the actual body.

## Production correction

- Optional headers are filtered separately; the mandatory `CRLF CRLF` separator is preserved.
- Bodies use UTF-8 base64 with 76-character lines. Empty bodies are refused.
- After the send response, the worker retrieves the Gmail message and compares its actual body to the confirmed body before advancing CRM or writing sent history. A failure records `EMAIL_BODY_UNVERIFIED:` with the message ID and leaves the item `send_unknown`, without automatic retransmission.
- The actual builder and verification are covered by `tests/followup-mime.cjs`. The worker regression suite covers failed verification without CRM/history/label advancement.
- A temporary function sent one fixed-recipient verification email to the existing Test inbox through the corrected builder. Gmail retained the full UTF-8 body. The temporary deployed function was removed after recovery.

## Recovery completed

- The 66 contacts represented 61 unique `(school, normalized recipient email)` groups. Five shared HC/AC addresses each received one recovery email. Other distinct coach addresses remained separate recipients.
- School-wide CRM and all known school Gmail threads were rechecked before recovery sends. Initial and final checks covered 46 schools and 85 known threads; no external replies were found.
- Original empty-message history was retained as an explanatory `note`, including the original Gmail message ID. Recovery items were held out of normal reservation candidates while work was pending.
- Recovery reused saved Follow-up #1 text and the original subject/thread. For a shared address, the HC's saved body was used when available. Both contacts received recovery history referring to the same sent message. Only one history row carries the Gmail message ID because the existing history index makes that ID unique per owner; the other row records it in its note.
- 61 distinct recovery messages were read back from Gmail: all were sent, all had nonempty bodies, and all matched the expected body, recipient and thread.
- 66 reservation items are `sent`, with 61 distinct recovery message IDs; 66 recovery history rows exist; no recovery item remains active or uncertain.
- All 66 contacts remain `contacted`, with `follow_up_count=1`. Existing `contact_count` values were preserved. Dates for Follow-up #2 were recalculated seven school-local calendar days after recovery (October 15 or 16). Recovery does not count as Follow-up #2 and does not schedule it automatically.
- Recovery messages have `Recruiting` and `Recruiting/Waiting Coach`; stale due/completed labels were removed from those messages.
- Some connector responses failed during CRM finalization. Their already-sent Gmail messages were verified and only database finalization was retried. No additional email was sent for those response failures.

Database snapshots and the per-recipient recovery journal were saved privately outside the repository. They contain message IDs and saved bodies for audit; no OAuth or API secrets were exported.
