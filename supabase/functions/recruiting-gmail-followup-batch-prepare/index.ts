import { withSupabase } from "npm:@supabase/server@1";
import { gmailGetThread, getHeader, GMAIL_ACCOUNT, googleAccessToken, latestOutbound, threadReplyFrom, plainTextMessage } from "../_shared/followup-batch-gmail.ts";
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

function threadSubject(subject: string): string {
  const clean = String(subject || "Akihiro Fujikawa Transfer Recruiting").replace(/[\r\n]/g, " ").trim();
  return /^re:/i.test(clean) ? clean : "Re: " + clean;
}

async function recordReply(supabase: any, contact: any, message: any) {
  const headers = message.payload?.headers || [];
  const receivedAt = new Date(Number(message.internalDate || Date.now())).toISOString();
  const messageId = getHeader(headers, "Message-ID") || String(message.id || "");
  const subject = getHeader(headers, "Subject");
  const body = plainTextMessage(message).slice(0, 4000);
  await supabase.from("recruiting_contacts").update({
    contact_status: "responded",
    coach_response: body || subject || "Gmail reply detected",
    last_contact_at: receivedAt,
    follow_up_date: null,
    auto_follow_up_enabled: false,
    next_action: "返信内容を確認",
  }).eq("id", contact.id).eq("owner_user_id", contact.owner_user_id);
  await supabase.from("recruiting_contact_history").upsert({
    owner_user_id: contact.owner_user_id,
    contact_id: contact.id,
    event_type: "reply_received",
    event_at: receivedAt,
    note: "予約送信前にGmail返信を検出" + (subject ? ": " + subject : ""),
    to_status: "responded",
    gmail_message_id: messageId || null,
    gmail_message_at: receivedAt,
  }, { onConflict: "owner_user_id,gmail_message_id", ignoreDuplicates: true });
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method === "OPTIONS") return json({ ok: true });
    if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

    try {
      const ownerId = String(ctx.jwtClaims?.sub ?? ctx.userClaims?.sub ?? "");
      if (!ownerId) return json({ ok: false, error: "Authentication required" }, 401);
      const payload = await req.json();
      const contactIds = Array.isArray(payload.contact_ids)
        ? Array.from(new Set(payload.contact_ids.map((id: unknown) => String(id).trim()).filter(Boolean)))
        : [];
      const localDate = String(payload.local_date || "");
      const localTime = String(payload.local_time || "");
      if (contactIds.length < 1 || contactIds.length > 67) {
        return json({ ok: false, error: "Choose between 1 and 67 contacts" }, 400);
      }

      const { data: contacts, error: contactsError } = await ctx.supabase
        .from("recruiting_contacts")
        .select("id,owner_user_id,university_id,coach_role,coach_name,coach_email,contact_status,coach_response,follow_up_date,follow_up_count,gmail_thread_id")
        .eq("owner_user_id", ownerId)
        .in("id", contactIds);
      if (contactsError) throw contactsError;
      if (!contacts || contacts.length !== contactIds.length) {
        return json({ ok: false, error: "One or more contacts are unavailable" }, 400);
      }

      const universityIds = Array.from(new Set(contacts.map((c: any) => Number(c.university_id))));
      const { data: schools, error: schoolsError } = await ctx.supabase
        .from("recruiting_universities")
        .select("id,name,latitude,longitude,is_test")
        .in("id", universityIds);
      if (schoolsError) throw schoolsError;
      const schoolMap = new Map((schools || []).map((s: any) => [Number(s.id), s]));
      const token = await googleAccessToken();
      const items = [];
      const skipped = [];

      for (const contact of contacts) {
        const school: any = schoolMap.get(Number(contact.university_id));
        const skip = (reason: string) => skipped.push({ contact_id: contact.id, school_name: school?.name || String(contact.university_id), reason });
        if (!school || school.is_test !== false || Number(contact.university_id) >= 900) {
          skip("本番の実在校ではないため対象外です。"); continue;
        }
        if (!["head_coach", "assistant_coach"].includes(contact.coach_role) ||
            !["contacted", "follow_up_due"].includes(contact.contact_status) ||
            Number(contact.follow_up_count || 0) > 1 ||
            !contact.coach_email || !contact.gmail_thread_id ||
            String(contact.coach_response || "").trim() ||
            !contact.follow_up_date) {
          skip("「送信済・返信待」でFollow-up期限が設定されたContactではありません。"); continue;
        }

        let zone: string, scheduledAt: string;
        try {
          zone = timezoneForCoordinates(Number(school.latitude), Number(school.longitude));
          scheduledAt = localScheduleToUtc(localDate, localTime, zone);
        } catch (error) {
          skip(error instanceof Error ? error.message : String(error)); continue;
        }
        if (String(contact.follow_up_date) > localDate) {
          skip("選択した学校現地の日付よりFollow-up期限が後です。"); continue;
        }

        const thread = await gmailGetThread(contact.gmail_thread_id, token);
        const reply = threadReplyFrom(thread, contact.coach_email);
        if (reply) {
          await recordReply(ctx.supabase, contact, reply);
          skip("Gmail上でコーチの返信を検出したため、CRMを「返信あり」に更新しました。");
          continue;
        }

        const outbound = latestOutbound(thread);
        if (!outbound) {
          skip("Gmail Threadに初回送信を確認できません。"); continue;
        }
        const subject = threadSubject(getHeader(outbound.payload?.headers || [], "Subject"));
        items.push({
          contact_id: contact.id,
          university_id: Number(contact.university_id),
          school_name: school.name,
          coach_name: contact.coach_name,
          coach_email: contact.coach_email,
          coach_role: contact.coach_role,
          follow_up_count: Number(contact.follow_up_count || 0),
          school_timezone: zone,
          scheduled_at: scheduledAt,
          subject,
          thread_id: contact.gmail_thread_id,
        });
      }

      return json({ ok: true, items, skipped });
    } catch (error) {
      console.error("Follow-up batch preparation failed:", error);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }),
};
