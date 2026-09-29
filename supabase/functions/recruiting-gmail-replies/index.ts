import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GMAIL_ACCOUNT = Deno.env.get("GMAIL_ACCOUNT") ?? "fujiakihiro8@gmail.com";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Required Phase 5-D secrets are not configured.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

function header(headers: any[] | undefined, name: string): string {
  return headers?.find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? "";
}

function emailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}


function classifyInterest(text: string) {
  const s = String(text || '').toLowerCase();
  const high = [
    'interested in akihiro','interested in your profile','interested in your player','interested in recruiting',
    'would like to learn more','would like to discuss','let\'s discuss','let us discuss','schedule a call',
    'schedule a meeting','set up a call','send me his highlight','send his highlight','send your transcript',
    'send me his transcript','send more information','send more info','good fit','great fit','strong fit',
    'could be a good fit','we are interested','we\'re interested','interested in having him','interested in having you',
    'transfer candidate','transfer opportunity','visit campus','official visit','unofficial visit','id camp','idcamp'
  ];
  const medium = [
    'keep me posted','keep us posted','please follow up','feel free to reach out','let me know',
    'send your profile','send your information','send more','happy to connect','open to a conversation',
    'tell me more','more information','more details','thanks for reaching out','thank you for reaching out'
  ];
  const low = [
    'not recruiting','not looking','no roster spots','no room','already full','not a fit','unable to',
    'cannot offer','can\'t offer','not interested','good luck with your transfer','best of luck','remove me'
  ];
  const hits=(terms:string[])=>terms.filter(t=>s.includes(t));
  const h=hits(high), m=hits(medium), l=hits(low);
  if(l.length && !h.length) return {level:'low',reason:'否定・対象外を示す表現を検出: '+l.slice(0,3).join(', ')};
  if(h.length>=1) return {level:'high',reason:'具体的な関心・次のアクションを示す表現を検出: '+h.slice(0,3).join(', ')};
  if(m.length>=1) return {level:'medium',reason:'前向きな接点継続を示す表現を検出: '+m.slice(0,3).join(', ')};
  return {level:'unknown',reason:'明確な関心表現を検出できませんでした。'};
}

function collectText(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const text = collectText(child);
      if (text) return text;
    }
  }
  return "";
}

async function getGmailAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID!,
    client_secret: GOOGLE_CLIENT_SECRET!,
    refresh_token: GOOGLE_REFRESH_TOKEN!,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Unable to refresh Google access token.");
  }
  return data.access_token;
}

async function gmailGet(path: string, token: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gmail API error: ${response.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const token = await getGmailAccessToken();

    const { data: contacts, error: contactsError } = await supabase
      .from("recruiting_contacts")
      .select("id,owner_user_id,university_id,coach_name,coach_email,contact_status,gmail_thread_id")
      .not("gmail_thread_id", "is", null);

    if (contactsError) throw contactsError;

    let checked = 0;
    let replies = 0;

    for (const contact of contacts ?? []) {
      if (!contact.gmail_thread_id) continue;
      checked++;

      const thread = await gmailGet(
        `threads/${encodeURIComponent(contact.gmail_thread_id)}?format=full`,
        token,
      );

      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const inbound = messages
        .filter((message: any) => {
          const from = emailAddress(header(message.payload?.headers, "From"));
          return from && from !== GMAIL_ACCOUNT.toLowerCase();
        })
        .sort((a: any, b: any) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));

      if (!inbound.length) continue;

      const latest = inbound[inbound.length - 1];
      const messageId = String(latest.id ?? "");
      if (!messageId) continue;

      const { data: existing } = await supabase
        .from("recruiting_contact_history")
        .select("id")
        .eq("owner_user_id", contact.owner_user_id)
        .eq("gmail_message_id", messageId)
        .maybeSingle();

      if (existing) continue;

      const from = header(latest.payload?.headers, "From");
      const subject = header(latest.payload?.headers, "Subject");
      const body = collectText(latest.payload);
      const interest = classifyInterest(body + "\n" + subject);
      const receivedAt = new Date(Number(latest.internalDate ?? Date.now())).toISOString();
      const note = [
        `Gmail返信: ${subject || "(件名なし)"}`,
        `From: ${from || contact.coach_email || contact.coach_name}`,
        body.trim() ? body.trim().slice(0, 4000) : "(本文を取得できませんでした)",
      ].join("\n");

      const { data: updated, error: updateError } = await supabase
        .from("recruiting_contacts")
        .update({
          contact_status: "responded",
          coach_response: body.trim().slice(0, 4000) || subject || "Gmail返信あり",
          last_contact_at: receivedAt,
          next_action: interest.level === "high" ? "優先確認：返信内容を確認" : "返信内容を確認",
          interest_level: interest.level,
          interest_reason: interest.reason,
          interest_analyzed_at: receivedAt,
        })
        .eq("id", contact.id)
        .eq("owner_user_id", contact.owner_user_id)
        .select("id")
        .single();

      if (updateError || !updated) throw updateError ?? new Error("CRM contact update failed.");

      const { error: historyError } = await supabase
        .from("recruiting_contact_history")
        .insert({
          owner_user_id: contact.owner_user_id,
          contact_id: contact.id,
          event_type: "reply_received",
          event_at: receivedAt,
          note,
          to_status: "responded",
          gmail_message_id: messageId,
          gmail_message_at: receivedAt,
        });

      if (historyError) throw historyError;
      if (interest.level === "high") {
        const { data: dashboard } = await supabase.from("recruiting_records").select("content").eq("id","akihiro_dashboard").eq("owner_user_id",contact.owner_user_id).maybeSingle();
        const current = dashboard?.content || {};
        const currentStatus = current.statuses?.[contact.university_id] || "未接触";
        if (["未接触","メール送信済","返信・関心あり"].includes(currentStatus) || !currentStatus) {
          const statuses = { ...(current.statuses || {}), [contact.university_id]: "返信・関心あり" };
          const nextContent = { ...current, statuses };
          await supabase.from("recruiting_records").upsert({id:"akihiro_dashboard",owner_user_id:contact.owner_user_id,content:nextContent,updated_at:new Date().toISOString()},{onConflict:"id"});
        }
      }

      replies++;
    }

    return json({ ok: true, checked, replies });
  } catch (error) {
    console.error("Phase 5-D reply detection failed:", error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
