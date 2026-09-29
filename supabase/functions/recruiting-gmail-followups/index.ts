import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN")!;
const GMAIL_ACCOUNT = (Deno.env.get("GMAIL_ACCOUNT") || "fujiakihiro8@gmail.com").toLowerCase();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function header(headers: any[], name: string) {
  return headers?.find((h: any) => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "";
}
function emailAddress(value: string) {
  const m = String(value || "").match(/<([^>]+)>/);
  return (m?.[1] || value || "").trim().toLowerCase();
}
function base64UrlFromUtf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function encodeSubject(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "=?UTF-8?B?" + btoa(binary) + "?=";
}
function cleanHeader(value: string) {
  return String(value || "").replace(/[\r\n]/g, " ").trim();
}
async function googleAccessToken() {
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
  if (!response.ok) throw new Error(data.error_description || data.error || "Google OAuth refresh failed");
  return data.access_token as string;
}
async function gmailGet(path: string, token: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    headers: { Authorization: "Bearer " + token },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gmail API error: ${response.status}`);
  return data;
}
async function gmailSend(raw: string, threadId: string, token: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ raw, threadId }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gmail send error: ${response.status}`);
  return data;
}
function addDays(isoDate: string, days: number) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function followUpSubject(subject: string, school: string) {
  const s = subject || `${school} Transfer Recruiting`;
  return /^re:/i.test(s) ? s : "Re: " + s;
}
function followUpBody(contact: any, school: string, originalSubject: string) {
  const first = (contact.coach_name || "Coach").trim().split(/\s+/).pop() || "Coach";
  return `Dear Coach ${first},

I wanted to follow up on my previous email regarding my interest in the ${school} men's soccer program as a transfer candidate.

I understand you have a busy schedule, but I would appreciate it if you could let me know whether my profile may be of interest for your program. My recruiting profile and highlight video are available here:

https://fujitame.github.io/profile/

Thank you again for your time and consideration.

Best regards,

Akihiro Fujikawa
Harcum College Men's Soccer
Email: fujiakihiro8@gmail.com`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const token = await googleAccessToken();
    const today = new Date().toISOString().slice(0, 10);

    const { data: contacts, error } = await supabase
      .from("recruiting_contacts")
      .select("id,owner_user_id,university_id,coach_name,coach_email,contact_status,last_contact_at,follow_up_date,follow_up_count,contact_count,gmail_thread_id,auto_follow_up_enabled,next_action")
      .eq("auto_follow_up_enabled", true)
      .not("gmail_thread_id", "is", null)
      .lte("follow_up_date", today)
      .in("contact_status", ["contacted", "follow_up_due"])
      .lt("follow_up_count", 2);

    if (error) throw error;

    let checked = 0, sent = 0, skipped = 0;
    for (const contact of contacts ?? []) {
      checked++;
      if (!contact.coach_email || !contact.gmail_thread_id) { skipped++; continue; }

      // Re-check the thread immediately before sending. If the coach has replied,
      // do not send a follow-up; Phase 5-D/this function will treat the reply as authoritative.
      const thread = await gmailGet(`threads/${encodeURIComponent(contact.gmail_thread_id)}?format=full`, token);
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const inbound = messages.filter((m: any) => {
        const from = emailAddress(header(m.payload?.headers || [], "From"));
        return from && from !== GMAIL_ACCOUNT;
      });
      if (inbound.length) {
        skipped++;
        await supabase.from("recruiting_contacts").update({
          contact_status: "responded",
          follow_up_date: null,
          next_action: "返信内容を確認",
        }).eq("id", contact.id).eq("owner_user_id", contact.owner_user_id);
        continue;
      }

      const latest = messages[messages.length - 1];
      const latestHeaders = latest?.payload?.headers || [];
      const originalSubject = header(latestHeaders, "Subject");
      const messageId = header(latestHeaders, "Message-ID");
      const references = header(latestHeaders, "References");
      const subject = followUpSubject(originalSubject, String(contact.university_id));

      const body = followUpBody(contact, String(contact.university_id), subject);
      const refs = [references, messageId].filter(Boolean).join(" ").trim();
      const mime = [
        "To: " + cleanHeader(contact.coach_email),
        "From: " + GMAIL_ACCOUNT,
        "Subject: " + encodeSubject(subject),
        messageId ? "In-Reply-To: " + cleanHeader(messageId) : "",
        refs ? "References: " + cleanHeader(refs) : "",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body,
      ].filter(Boolean).join("\r\n");

      const result = await gmailSend(base64UrlFromUtf8(mime), contact.gmail_thread_id, token);
      const count = Number(contact.follow_up_count || 0) + 1;
      const contactCount = Number(contact.contact_count || 0) + 1;
      const sentAt = new Date().toISOString();
      const exhausted = count >= 2;
      const nextDate = exhausted ? null : addDays(today, 7);

      const update = await supabase.from("recruiting_contacts").update({
        contact_status: exhausted ? "no_response" : "contacted",
        last_contact_at: sentAt,
        contact_count: contactCount,
        follow_up_count: count,
        last_follow_up_at: sentAt,
        follow_up_date: nextDate,
        next_action: exhausted ? "2回フォローアップ済み・返信なし" : "次回フォローアップメール送信",
        gmail_thread_id: result.threadId || contact.gmail_thread_id,
      }).eq("id", contact.id).eq("owner_user_id", contact.owner_user_id);
      if (update.error) throw update.error;

      const history = await supabase.from("recruiting_contact_history").insert({
        owner_user_id: contact.owner_user_id,
        contact_id: contact.id,
        event_type: "follow_up_sent",
        event_at: sentAt,
        note: `自動フォローアップ送信（${count}/2）: ${subject}`,
        to_status: exhausted ? "no_response" : "contacted",
      });
      if (history.error) throw history.error;
      sent++;
    }

    return json({ ok: true, date: today, checked, sent, skipped });
  } catch (error) {
    console.error("Phase 5-E follow-up failed:", error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
