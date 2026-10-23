# School CRM Research and November reapproach preparation

Each existing school contact drawer loads that school's tagged REAPPROACH_2026_11 records, including inactive planning research, through the authenticated user's existing research-table RLS. The compact collapsed panel shows the senior/defender aggregate, source check dates, verified-vs-supplied evidence, and expandable school-specific notes and unresolved questions.

The separate draft preparation button reads the current contact, current Player Master and current tagged school research. It assembles a school-specific question for each of the 25 UC/CSU schools. Verified match/biography examples for UCI, CSUSB and Humboldt can be used as precise context; counts are never converted into vacancies. An existing recorded coach reply changes the opening and adds a requirement to reread the actual latest email. Role, eligibility, incoming players and financial terms remain verification tasks.

This is a deterministic draft preparation feature inside the authenticated CRM. It does not call a new external AI service, forward Gmail/private conversations, send emails, create reservations or write CRM contact/history state. The user can edit and copy the subject and body. New-update notes are shown in the checks, not treated as verified new player facts.

The canonical pure builder is supabase/functions/_shared/reapproach-draft.ts; its exports are inlined into index.html for GitHub Pages. The test verifies the inline builder matches the canonical source.

Research remains inactive for ordinary Follow-up candidate selectors. November preparation reads it explicitly through this separate UI. Live source/eligibility/incoming-player and latest-email checks are still required before actual outreach. Sonoma State remains the separate restart planning entry in the prior handoff artifact.

Verification: pure-builder tests cover all 25 different role questions; verified-fact gating; supplied counts; current master/GPA/highlight data; prior-reply handling; new-update caveats; URL safety and inline source consistency. Inline UI JavaScript syntax passed. A visual browser smoke test could not launch because the container's browser executable is absent; no signed-in production screen claim is made.
