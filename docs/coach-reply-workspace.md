# Coach reply workspace
Prepared 2026-10-26.

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

Deployment state: reply sender v20 is deployed with optional CC and read-only prepare; it remains compatible with existing clients. Auto-review rejected replacing the AI function because external processing of coach/private text requires explicit user approval of destination and data. AI changes and this combined UI are prepared in the feature PR; do not publish the new UI until the updated AI contract is deployed. Existing production UI and AI remain unchanged.

Validation: mocked Gemini tests cover modes, direction/analysis use, translation, owner/contact scope and stale source guards. Mocked Gmail tests cover read-only prepare, original subject/threading, CC MIME/dedup/header injection/mismatch, stale Message-ID and uncertainty handling. UI fixtures cover per-contact drafts, stale async results, translation staleness, Stage gating, CC reset and final review. Existing MIME and accepted-send UI tests pass. No actual mail was sent.
