# Coach reply workspace
Released 2026-10-26.

Flow: analyze the stored coach reply; enter the player's direction; generate an editable English reply and a faithful Japanese translation; confirm the current recruiting Stage (and accept/dismiss any AI stage proposal); open the CRM Gmail composer; review To, CC, Stage and English content; explicitly send.

Manual reply: fetch the original Gmail thread subject using authenticated action=prepare (read-only), create only Dear Coach [last name], blank paragraphs and the player signature. No generic body is inserted. The same Stage/CC review applies. Blank manual skeletons cannot be sent from the UI.

CC: bare email addresses separated by comma or semicolon, maximum ten. Case-normalized deduplication and removal of the To recipient. A separate, initially unchecked checkbox adds exactly recruit@withtyou-usa.com. Invalid addresses or CR/LF are rejected on both client and server. CC is written into MIME headers and checked again during Gmail readback. CC appears in the CRM reply history note. CC/forwarded link engagement remains attributed to the original email; individual viewers cannot be identified.

Safety: preserve user auth and owner RLS. Prepare never sends mail, creates tracking or changes CRM. Final send checks the snapshotted inbound Message-ID. Accepted-but-unverified sends remain accepted and must not be blindly retried. Editing content or CC clears the final review checkbox. Switching contacts discards late asynchronous results; in-memory direction/drafts are kept separately for each contact/source reply. Editing English marks the Japanese translation as stale and permits explicit retranslation. No automatic Stage change.

AI data processing approval:
- Destination: existing Google Gemini API, https://generativelanguage.googleapis.com/v1beta/interactions.
- Draft/analysis input: stored coach reply (which may include signature/contact details), the user's direction, the prior analysis, relevant school Research, public player facts (name/school/position/GPA/transfer target/Profile/video), and contact event types/dates.
- Explicit player phone/email fields and internal history notes are omitted from the new prompt.
- Retranslation input: the English subject/body only. Credentials are never part of the model prompt.
- AI data is processed only on explicit analyze/generate/translate actions. No mail sending or reservations are performed by these actions.

Deployment state: The user explicitly approved Google Gemini processing of the listed data on 2026-10-26. Reply sender v20 and AI reply workspace v31 are deployed with the existing user authentication. PR #43 is merged; GitHub Pages deployment succeeded. Original subject preparation and optional CC remain compatible with existing clients. Live authenticated UI verification requires a CRM login; provider and Gmail behavior are covered by the mocked tests below.

Validation: mocked Gemini tests cover modes, direction/analysis use, translation, owner/contact scope and stale source guards. Mocked Gmail tests cover read-only prepare, original subject/threading, CC MIME/dedup/header injection/mismatch, stale Message-ID and uncertainty handling. UI fixtures cover per-contact drafts, stale async results, translation staleness, Stage gating, CC reset and final review. Existing MIME and accepted-send UI tests pass. No actual mail was sent.

## Coach CRM simplification — 2026-11-12

The drawer now starts with the coach's current communication state, the school-wide cumulative progress, the last contact date and the next recorded action. The saved coach response is read-only in this overview. One main action routes to the relevant flow:
- Unanswered outreach: open the coach's registered campaign in activity.html, initial stage, preparation mode. Membership is checked before opening the editor; no jobs or sends are created.
- A different coach at the same school replied: open school reply handling rather than the bulk reapproach flow.
- An actionable coach reply: expand the existing reply workspace, preserving manual/AI preparation, per-contact draft state and source guards.
- Waiting after our reply or a closed contact: inspect history.
- A conversation Follow-up due: use the existing conversation composer and eligibility checks.

The record editor is collapsed by default. Dates, lifetime contact/Follow-up counts, automation and raw stored response corrections are grouped under manual record corrections. School progress keeps its existing immediate-save behavior, explicitly labeled separately from the record save button.

Only relevant individual mail sections are visible. Analysis is optional; automatic draft generation no longer forces the analysis disclosure open. Generated rationale/requested items, progress corrections, engagement measurements and school research are disclosures. The actual draft fields appear after a draft is started, rather than appearing blank after analysis alone. CC, source-thread validation, Stage review and the final explicit Gmail send remain unchanged.

History event titles and status changes use readable labels. History results and record-save UI updates are scoped to the active coach, preventing late responses from replacing another coach's view. Returning to a coach resets disclosure positions while retaining the existing per-coach in-memory reply draft.

Validation: node tests/coach-flow.cjs; node tests/reply-workspace.cjs; node tests/gmail-send-ui.cjs; node tests/navigation.test.cjs; node tests/status-model.test.cjs; node tests/campaign-workspace.test.cjs. These are mocked UI/backend tests; no live email, AI draft request, reservation or bulk label operation was performed.
