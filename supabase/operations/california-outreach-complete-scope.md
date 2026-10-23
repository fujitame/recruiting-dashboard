# Complete California initial-outreach scope and favorites
All 42 active California NCAA D1/D2 schools were reconciled against CRM contacts and current reservations on 2026-10-23.
- 19 schools already have contact history.
- 20 newly added schools had 35 reservations.
- Sacramento State, LMU and UCLA were uncontacted and were added: 5 emails / 6 coach contacts. UCLA uses the HC name for its shared HC/AC inbox.
- Total: 23 schools / 40 distinct reserved messages, all scheduled at 2026-10-23 08:00 America/Los_Angeles (2026-10-24 00:00 Asia/Tokyo).
- Existing contacted schools are not reintroduced as first contacts. Unpublished individual addresses remain excluded.
- Initial worker allowlist now includes only the 3 supplemental IDs plus 107–126, and additionally checks California region and NCAA D1/D2 classification.
- The verified-send finalizer adds the school to recruiting_records.content.favs inside the same transaction as CRM/history finalization. A skipped or uncertain send does not add a favorite.
- Preference saves merge the user's explicit favorite changes against the current row under a lock. An older open dashboard cannot erase automatic additions just by saving another setting.
- Payloads, body text and recipient contact IDs remain in the private database; the committed scope audit contains only school-level results.

Validation: worker policy tests cover supplemental schools and wrong-region exclusion; UI script syntax passed. A rollback transaction verified send-to-favorite behavior, preservation of prior favorites, stale preference saves, explicit removal, and that all 40 live reservations remained scheduled afterwards. No email was sent during these checks.
