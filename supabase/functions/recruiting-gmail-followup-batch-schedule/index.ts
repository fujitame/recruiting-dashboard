import { withSupabase } from "npm:@supabase/server@1";
import { gmailGetThread, getHeader, googleAccessToken, latestOutbound, threadReplyFrom } from "../_shared/followup-batch-gmail.ts";
import { localScheduleToUtc, timezoneForCoordinates } from "../_shared/followup-batch-timezone.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function expectedThreadSubject(value: string): string {
  const clean = String(value || "Akihiro Fujikawa Transfer Recruiting").replace(/[\r\n]/g, " ").trim();
  return /^re:/i.test(clean) ? clean : "Re: " + clean;
}

function usedResearchIds(history: any[]): number[] {
  return Array.from(new Set((history || [])
    .flatMap((row: any) => Array.isArray(row.research_ids) ? row.research_ids : [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isInteger(id) && id > 0)));
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method === "OPTIONS") return json({ ok: true });
    if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

    try {
      const ownerId = String(ctx.jwtClaims?.sub ?? ctx.userClaims?.sub ?? "");
      if (!ownerId) return json({ ok: false, error: "Authentication required" }, 401);
      const payload = await req.json();
      const localDate = String(payload.local_date || "");
      const localTime = String(payload.local_time || "");
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length < 1 || items.length > 67) {
        return json({ ok: false, error: "Choose between 1 and 67 contacts" }, 400);
      }
      if (new Set(items.map((item: any) => String(item.contact_id || ""))).size !== items.length) {
        return json({ ok: false, error: "A coach can only appear once in a batch" }, 400);
      }

      const contactIds = items.map((item: any) => String(item.contact_id || ""));
      const { data: contacts, error: contactError } = await ctx.supabase
        .from("recruiting_contacts")
        .select("id,owner_user_id,university_id,coach_role,coach_name,coach_email,contact_status,coach_response,follow_up_date,follow_up_count,gmail_thread_id")
        .eq("owner_user_id", ownerId)
        .in("id", contactIds);
      if (contactError) throw contactError;
      if (!contacts || contacts.length !== items.length) throw new Error("One or more CRM contacts changed or are unavailable.");

      const ids = Array.from(new Set(contacts.map((c: any) => Number(c.university_id))));
      const { data: schools, error: schoolError } = await ctx.supabase
        .from("recruiting_universities")
        .select("id,name,latitude,longitude,is_test")
        .in("id", ids);
      if (schoolError) throw schoolError;
      const schoolById = new Map((schools || []).map((school: any) => [Number(school.id), school]));
      const contactById = new Map(contacts.map((contact: any) => [String(contact.id), contact]));
      const itemById = new Map(items.map((item: any) => [String(item.contact_id), item]));
      const token = await googleAccessToken();
      const rpcItems = [];

      for (const contact of contacts) {
        const item: any = itemById.get(String(contact.id));
        const school: any = schoolById.get(Number(contact.university_id));
        if (!school || school.is_test !== false || Number(contact.university_id) >= 900) {
          throw new Error("Test or unavailable schools cannot be scheduled for production sending.");
        }
        if (!["head_coach", "assistant_coach"].includes(contact.coach_role) ||
            !["contacted", "follow_up_due"].includes(contact.contact_status) ||
            Number(contact.follow_up_count || 0) > 1 ||
            !contact.coach_email || !contact.gmail_thread_id ||
            String(contact.coach_response || "").trim() ||
            !contact.follow_up_date || String(contact.follow_up_date) > localDate) {
          throw new Error(school.name + " is no longer eligible for a no-reply Follow-up.");
        }

        const timezone = timezoneForCoordinates(Number(school.latitude), Number(school.longitude));
        const scheduledAt = localScheduleToUtc(localDate, localTime, timezone);
        const thread = await gmailGetThread(contact.gmail_thread_id, token);
        if (threadReplyFrom(thread, contact.coach_email)) {
          throw new Error(school.name + " has a new Gmail reply. Refresh CRM before scheduling.");
        }
        const outbound = latestOutbound(thread);
        if (!outbound) throw new Error(school.name + " has no confirmed outbound message in its Gmail thread.");
        const subject = expectedThreadSubject(getHeader(outbound.payload?.headers || [], "Subject"));
        const expectedLastMessageId = getHeader(outbound.payload?.headers || [], "Message-ID");
        if (!expectedLastMessageId) throw new Error(school.name + " Gmail message ID is missing; scheduling is blocked.");
        if (String(item.subject || "").trim() !== subject) {
          throw new Error(school.name + " email subject changed since preview. Generate the draft again.");
        }

        const sentence = String(item.personalization_sentence || "").trim();
        const body = String(item.body || "");
        const researchIds = Array.isArray(item.research_ids)
          ? item.research_ids.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
          : [];
        if (!sentence || !body.includes(sentence) || !researchIds.length) {
          throw new Error(school.name + " must retain its school-specific verified Research sentence.");
        }

        const { data: history, error: historyError } = await ctx.supabase
          .from("recruiting_contact_history")
          .select("research_ids")
          .eq("contact_id", contact.id);
        if (historyError) throw historyError;
        const excludedIds = usedResearchIds(history || []);
        const recipientRole = contact.coach_role === "head_coach" ? "HC" : "AC";
        const { data: availableResearch, error: researchError } = await ctx.supabase.rpc(
          "get_personalization_context_excluding",
          {
            p_university_id: Number(contact.university_id),
            p_recipient_role: recipientRole,
            p_recipient_name: String(contact.coach_name || ""),
            p_excluded_ids: excludedIds,
            p_max_facts: 2,
          },
        );
        if (researchError) throw researchError;
        const validIds = new Set((availableResearch || []).map((row: any) => Number(row.research_id)));
        if (!researchIds.every((id: number) => validIds.has(id))) {
          throw new Error(school.name + " Research has changed or is no longer available. Generate the draft again.");
        }

        rpcItems.push({
          contact_id: contact.id,
          scheduled_at: scheduledAt,
          school_timezone: timezone,
          subject,
          expected_last_message_id: expectedLastMessageId,
          body,
          personalization_sentence: sentence,
          research_ids: researchIds,
        });
      }

      const { data: batchId, error: scheduleError } = await ctx.supabase.rpc(
        "schedule_recruiting_followup_batch",
        { p_local_date: localDate, p_local_time: localTime, p_items: rpcItems },
      );
      if (scheduleError) throw scheduleError;

      return json({
        ok: true,
        batch_id: batchId,
        scheduled_count: rpcItems.length,
        items: rpcItems.map((item: any, i: number) => ({
          contact_id: item.contact_id,
          scheduled_at: item.scheduled_at,
          school_timezone: item.school_timezone,
        })),
      });
    } catch (error) {
      console.error("Follow-up batch schedule failed:", error);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }),
};
