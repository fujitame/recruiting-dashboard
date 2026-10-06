import { createClient } from "npm:@supabase/supabase-js@2";
import { syncRecruitingThreadLabels } from "../_shared/recruiting-gmail-labels.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DISPATCH_SECRET = Deno.env.get("RECRUITING_FOLLOWUP_BATCH_DISPATCH_SECRET");
const GMAIL_ACCOUNT = (Deno.env.get("GMAIL_ACCOUNT") || "fujiakihiro8@gmail.com").toLowerCase();
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DISPATCH_SECRET || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  throw new Error("Required batch dispatcher secrets are not configured.");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-recruiting-secret",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function header(headers: any[], name: string) {
  return headers?.find((value: any) => String(value.name || "").toLowerCase() === name.toLowerCase())?.value || "";
}

function emailAddress(value: string) {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match?.[1] || value || "").trim().toLowerCase();
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
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      refresh_token: GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google OAuth refresh failed");
  }
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

function threadHasReply(thread: any, coachEmail: string) {
  const target = String(coachEmail || "").trim().toLowerCase();
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return messages.some((message: any) => {
    const from = emailAddress(header(message.payload?.headers || [], "From"));
    return from && from !== GMAIL_ACCOUNT && from === target;
  });
}

function localDate(value: string, timeZone: string) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

async function finishItem(id: string, status: string, values: Record<string, unknown> = {}) {
  const { error } = await supabase
    .from("recruiting_followup_batch_items")
    .update({ status, completed_at: new Date().toISOString(), ...values })
    .eq("id", id)
    .eq("status", "sending");
  if (error) throw error;
}

async function markSchoolReplied(ownerId: string, universityId: number, repliedContact: any) {
  if (repliedContact?.id) {
    await supabase.from("recruiting_contacts").update({
      contact_status: "responded",
      follow_up_date: null,
      auto_follow_up_enabled: false,
      next_action: "返信内容を確認",
    }).eq("id", repliedContact.id);
  }
  await supabase.from("recruiting_followup_batch_items").update({
    status: "skipped",
    completed_at: new Date().toISOString(),
    outcome_note: "School reply detected before send",
  }).eq("owner_user_id", ownerId).eq("university_id", universityId).eq("status", "pending");
}

async function processItem(item: any, token: string) {
  const { data: contact, error: contactError } = await supabase
    .from("recruiting_contacts")
    .select("*")
    .eq("id", item.contact_id)
    .eq("owner_user_id", item.owner_user_id)
    .maybeSingle();
  if (contactError) throw contactError;
  if (!contact) {
    await finishItem(item.id, "skipped", { outcome_note: "CRM contact no longer exists" });
    return "skipped";
  }

  const { data: school, error: schoolError } = await supabase
    .from("recruiting_universities")
    .select("id,is_test")
    .eq("id", item.university_id)
    .maybeSingle();
  if (schoolError) throw schoolError;
  if (!school || school.is_test || Number(school.id) >= 900 && Number(school.id) <= 999) {
    await finishItem(item.id, "skipped", { outcome_note: "Test or unavailable school" });
    return "skipped";
  }

  const scheduledLocalDate = localDate(item.scheduled_at, item.timezone);
  if (
    contact.university_id !== item.university_id ||
    String(contact.coach_email || "").trim().toLowerCase() !== String(item.to_email || "").trim().toLowerCase() ||
    !contact.gmail_thread_id ||
    Number(contact.follow_up_count || 0) !== 0 ||
    !["contacted", "follow_up_due"].includes(contact.contact_status) ||
    !contact.follow_up_date ||
    contact.follow_up_date > scheduledLocalDate ||
    String(contact.coach_response || "").trim()
  ) {
    await finishItem(item.id, "skipped", { outcome_note: "Contact no longer eligible" });
    return "skipped";
  }

  const { data: schoolContacts, error: schoolContactsError } = await supabase
    .from("recruiting_contacts")
    .select("id,coach_email,gmail_thread_id,contact_status,coach_response")
    .eq("owner_user_id", item.owner_user_id)
    .eq("university_id", item.university_id);
  if (schoolContactsError) throw schoolContactsError;

  const threads = new Map<string, any>();
  for (const schoolContact of schoolContacts || []) {
    if (schoolContact.contact_status === "responded" || String(schoolContact.coach_response || "").trim()) {
      await markSchoolReplied(item.owner_user_id, item.university_id, schoolContact);
      await finishItem(item.id, "skipped", { outcome_note: "A coach at this school has replied" });
      return "skipped";
    }
    if (!schoolContact.coach_email || !schoolContact.gmail_thread_id) continue;
    const thread = await gmailGet(`threads/${encodeURIComponent(schoolContact.gmail_thread_id)}?format=full`, token);
    threads.set(schoolContact.id, thread);
    if (threadHasReply(thread, schoolContact.coach_email)) {
      await markSchoolReplied(item.owner_user_id, item.university_id, schoolContact);
      await finishItem(item.id, "skipped", { outcome_note: "A coach at this school has replied" });
      return "skipped";
    }
  }

  const targetThread = threads.get(contact.id);
  if (!targetThread || !Array.isArray(targetThread.messages) || !targetThread.messages.length) {
    await finishItem(item.id, "failed", { outcome_note: "Could not verify Gmail thread; no email sent" });
    return "failed";
  }

  const latest = targetThread.messages[targetThread.messages.length - 1];
  const headers = latest?.payload?.headers || [];
  const messageId = header(headers, "Message-ID");
  const references = header(headers, "References");
  const refs = [references, messageId].filter(Boolean).join(" ").trim();
  const mime = [
    "To: " + cleanHeader(item.to_email),
    "From: " + GMAIL_ACCOUNT,
    "Subject: " + encodeSubject(item.subject),
    messageId ? "In-Reply-To: " + cleanHeader(messageId) : "",
    refs ? "References: " + cleanHeader(refs) : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    item.body,
  ].filter(Boolean).join("\r\n");

  let sent;
  try {
    sent = await gmailSend(base64UrlFromUtf8(mime), contact.gmail_thread_id, token);
  } catch (error) {
    // A transport error may occur after Gmail accepted the message.
    // Keep this terminal to avoid an unsafe automatic duplicate retry.
    await finishItem(item.id, "failed", { outcome_note: "Send result uncertain; inspect Gmail before retrying" });
    throw error;
  }

  const sentAt = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("recruiting_contacts")
    .update({
      contact_status: "contacted",
      last_contact_at: sentAt,
      contact_count: Number(contact.contact_count || 0) + 1,
      follow_up_count: 1,
      last_follow_up_at: sentAt,
      follow_up_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      auto_follow_up_enabled: true,
      next_action: "次回フォローアップメール送信",
      gmail_thread_id: sent.threadId || contact.gmail_thread_id,
    })
    .eq("id", contact.id)
    .eq("follow_up_count", 0)
    .select("*")
    .maybeSingle();

  if (updateError || !updated) {
    await finishItem(item.id, "failed", {
      gmail_message_id: sent.id || null,
      gmail_thread_id: sent.threadId || contact.gmail_thread_id,
      outcome_note: "Gmail sent but CRM update failed; do not retry",
    });
    return "failed";
  }

  await supabase.from("recruiting_contact_history").insert({
    owner_user_id: updated.owner_user_id,
    contact_id: updated.id,
    event_type: "follow_up_sent",
    event_at: sentAt,
    note: "Follow-up #1 Gmail batch send: " + item.subject,
    to_status: "contacted",
    gmail_message_id: sent.id || null,
    gmail_message_at: sentAt,
    research_ids: item.research_ids || [],
  });

  try {
    await syncRecruitingThreadLabels(
      sent.threadId || updated.gmail_thread_id || contact.gmail_thread_id,
      "Recruiting/Waiting Coach",
    );
  } catch (error) {
    console.warn("Follow-up batch Gmail label sync failed:", error);
  }

  await finishItem(item.id, "sent", {
    gmail_message_id: sent.id || null,
    gmail_thread_id: sent.threadId || contact.gmail_thread_id,
    outcome_note: null,
  });
  return "sent";
}

async function updateCompletedBatches() {
  const { data: active, error } = await supabase
    .from("recruiting_followup_batch_items")
    .select("batch_id")
    .in("status", ["pending", "sending"]);
  if (error) throw error;
  const activeIds = new Set((active || []).map((item: any) => item.batch_id));
  const { data: batches, error: batchError } = await supabase
    .from("recruiting_followup_batches")
    .select("id")
    .eq("status", "approved");
  if (batchError) throw batchError;
  const completed = (batches || []).filter((batch: any) => !activeIds.has(batch.id)).map((batch: any) => batch.id);
  if (completed.length) {
    await supabase.from("recruiting_followup_batches").update({
      status: "completed",
      completed_at: new Date().toISOString(),
    }).in("id", completed);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  if (req.headers.get("x-recruiting-secret") !== DISPATCH_SECRET) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const token = await googleAccessToken();
    const { data: items, error } = await supabase.rpc(
      "claim_due_recruiting_followup_batch_items",
      { p_limit: 8 },
    );
    if (error) throw error;

    const results = [];
    for (const item of items || []) {
      try {
        results.push({ id: item.id, status: await processItem(item, token) });
      } catch (error) {
        console.error("Batch item failed:", item.id, error);
        const note = error instanceof Error ? error.message : String(error);
        await finishItem(item.id, "failed", { outcome_note: note.slice(0, 500) }).catch(() => {});
        results.push({ id: item.id, status: "failed" });
      }
    }

    await updateCompletedBatches();
    return json({ ok: true, processed: results.length, results });
  } catch (error) {
    console.error("Follow-up batch dispatch failed:", error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
