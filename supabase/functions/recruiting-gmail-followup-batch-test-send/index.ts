import { withSupabase } from "npm:@supabase/server@1";

const TEST_RECIPIENT = "fujitame@gmail.com";
const GMAIL_ACCOUNT = (Deno.env.get("GMAIL_ACCOUNT") || "fujiakihiro8@gmail.com").toLowerCase();
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

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

function cleanHeader(value: string) {
  return String(value || "").replace(/[\r\n]/g, " ").trim();
}

function base64FromUtf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64UrlFromUtf8(value: string) {
  return base64FromUtf8(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeSubject(value: string) {
  return "=?UTF-8?B?" + base64FromUtf8(value) + "?=";
}

async function googleAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google OAuth is not configured.");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google OAuth refresh failed");
  }
  return data.access_token as string;
}

async function gmailSend(raw: string, token: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const data = await response.json();
  if (!response.ok || !data.id) {
    throw new Error(data.error?.message || "Gmail did not confirm the message");
  }
  return data;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method === "OPTIONS") return json({ ok: true });
    if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

    try {
      const ownerId = String(ctx.jwtClaims?.sub ?? ctx.userClaims?.sub ?? "");
      if (!ownerId) return json({ ok: false, error: "Authentication required" }, 401);

      const payload = await req.json();
      if (payload.confirm_test_send !== true || !Array.isArray(payload.items)) {
        return json({ ok: false, error: "Explicit test-send confirmation is required" }, 400);
      }
      const items = payload.items;
      if (items.length < 1 || items.length > 6) {
        return json({ ok: false, error: "Choose 1 to 6 TEST contacts (schools 900–902)" }, 400);
      }

      const contactIds = items.map((item: any) => String(item.contact_id || ""));
      if (contactIds.some((id: string) => !id) || new Set(contactIds).size !== contactIds.length) {
        return json({ ok: false, error: "Contact IDs must be unique" }, 400);
      }

      const { data: contacts, error: contactError } = await ctx.supabase
        .from("recruiting_contacts")
        .select("id,owner_user_id,university_id,coach_role,contact_status,coach_response,follow_up_count")
        .eq("owner_user_id", ownerId)
        .in("id", contactIds);
      if (contactError) throw contactError;
      if (!contacts || contacts.length !== items.length) {
        return json({ ok: false, error: "One or more test Contacts are unavailable" }, 400);
      }

      const universityIds = contacts.map((contact: any) => Number(contact.university_id));
      if (universityIds.some((id: number) => ![900, 901, 902].includes(id))) {
        return json({ ok: false, error: "Only TEST schools 900, 901, and 902 are enabled in this stage" }, 403);
      }

      const { data: schools, error: schoolError } = await ctx.supabase
        .from("recruiting_universities")
        .select("id,name,is_test")
        .in("id", universityIds);
      if (schoolError) throw schoolError;
      if (!schools || schools.length !== new Set(universityIds).size || schools.some((school: any) => school.is_test !== true)) {
        return json({ ok: false, error: "Every university must be marked as a test school" }, 403);
      }

      const { data: schoolContacts, error: replyError } = await ctx.supabase.from("recruiting_contacts")
        .select("university_id,contact_status,coach_response").eq("owner_user_id", ownerId).in("university_id", universityIds);
      if (replyError) throw replyError;
      if ((schoolContacts || []).some((c: any) => c.contact_status === "responded" || String(c.coach_response || "").trim())) {
        return json({ ok: false, error: "A coach at a selected school has replied; school-wide Follow-up is blocked" }, 409);
      }
      const contactById = new Map(contacts.map((contact: any) => [String(contact.id), contact]));
      const schoolById = new Map(schools.map((school: any) => [Number(school.id), school]));
      const normalized = [];
      const sentenceSchools = new Map<string, number>();

      for (const item of items) {
        const contact = contactById.get(String(item.contact_id));
        const school = contact && schoolById.get(Number(contact.university_id));
        const sentence = String(item.personalization_sentence || "").trim();
        const subject = String(item.subject || "").trim();
        const body = String(item.body || "");

        if (!contact || !school) return json({ ok: false, error: "Test contact validation failed" }, 403);
        if (
          !["head_coach", "assistant_coach"].includes(contact.coach_role) ||
          Number(contact.follow_up_count || 0) !== 0 ||
          contact.contact_status === "responded" ||
          String(contact.coach_response || "").trim()
        ) {
          return json({ ok: false, error: school.name + " is not eligible for Follow-up #1" }, 409);
        }
        if (!sentence || sentence.length > 700 || !body.includes(sentence)) {
          return json({ ok: false, error: school.name + " is missing its generated school-specific sentence" }, 400);
        }
        const sentenceKey = sentence.toLowerCase().replace(/\s+/g, " ").trim();
        if (sentenceSchools.has(sentenceKey) && sentenceSchools.get(sentenceKey) !== Number(contact.university_id)) {
          return json({ ok: false, error: "Each school must have a different personalization sentence" }, 400);
        }
        sentenceSchools.set(sentenceKey, Number(contact.university_id));
        if (!subject || subject.length > 180 || !body.trim() || body.length > 10000) {
          return json({ ok: false, error: school.name + " has an invalid subject or body" }, 400);
        }
        normalized.push({ schoolName: String(school.name), subject, body });
      }

      const token = await googleAccessToken();
      const runId = crypto.randomUUID().slice(0, 8);
      const results = [];

      for (const item of normalized) {
        const subject = "[CRM SELF TEST " + runId + "] " + item.schoolName + " · " + cleanHeader(item.subject);
        const body = [
          "TEST ONLY — This message is addressed to " + TEST_RECIPIENT + ".",
          "School: " + item.schoolName,
          "",
          item.body.trim(),
          "",
          "This message was sent by the recruiting CRM self-test. It was not sent to a coach and no CRM record was changed.",
        ].join("\r\n");
        const mime = [
          "To: " + TEST_RECIPIENT,
          "From: " + GMAIL_ACCOUNT,
          "Subject: " + encodeSubject(subject),
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: 8bit",
          "",
          body,
        ].join("\r\n");

        try {
          const sent = await gmailSend(base64UrlFromUtf8(mime), token);
          results.push({ school: item.schoolName, status: "sent", message_id: sent.id });
        } catch (error) {
          return json({
            ok: false,
            sent_count: results.length,
            results,
            error: "送信は途中で停止しました。送信済み分と受信トレイを確認してください。原因: " +
              (error instanceof Error ? error.message : String(error)),
          });
        }
      }

      return json({ ok: true, recipient: TEST_RECIPIENT, sent_count: results.length, results });
    } catch (error) {
      console.error("Follow-up batch self-test failed:", error);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }),
};
