import { withSupabase } from "npm:@supabase/server@1";

import {
  syncRecruitingThreadLabels,
} from "../_shared/recruiting-gmail-labels.ts";

const GMAIL_ACCOUNT =
  (Deno.env.get("GMAIL_ACCOUNT") || "fujiakihiro8@gmail.com").toLowerCase();

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

if (
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REFRESH_TOKEN
) {
  throw new Error("Required Gmail secrets are not configured.");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type",
    },
  });
}

function header(headers: any[], name: string) {
  return (
    headers?.find(
      (h: any) =>
        String(h.name || "").toLowerCase() === name.toLowerCase(),
    )?.value || ""
  );
}

function emailAddress(value: string) {
  const m = String(value || "").match(/<([^>]+)>/);
  return (m?.[1] || value || "").trim().toLowerCase();
}

function cleanHeader(value: string) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

function base64FromUtf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 0x8000),
    );
  }

  return btoa(binary);
}

function base64UrlFromUtf8(value: string) {
  return base64FromUtf8(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeSubject(value: string) {
  return "=?UTF-8?B?" + base64FromUtf8(value) + "?=";
}

async function googleAccessToken() {
  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID!,
        client_secret: GOOGLE_CLIENT_SECRET!,
        refresh_token: GOOGLE_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }),
    },
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        "Google OAuth refresh failed",
    );
  }

  return data.access_token as string;
}

async function gmailGet(path: string, token: string) {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/" + path,
    {
      headers: {
        Authorization: "Bearer " + token,
      },
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        `Gmail API error: ${response.status}`,
    );
  }

  return data;
}

async function gmailSend(
  raw: string,
  threadId: string,
  token: string,
) {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        raw,
        threadId,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        `Gmail send error: ${response.status}`,
    );
  }

  return data;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method === "OPTIONS") {
      return json({ ok: true });
    }

    if (req.method !== "POST") {
      return json(
        { ok: false, error: "POST required" },
        405,
      );
    }

    try {
      const supabase = ctx.supabase;
      const payload = await req.json();

      const contactId =
        String(payload.contact_id || "").trim();

      const subject =
        String(payload.subject || "").trim();

      const body =
        String(payload.body || "");

      const testForceDue =
        payload.test_force_due === true;

      if (!contactId || !subject || !body.trim()) {
        return json(
          {
            ok: false,
            error:
              "contact_id, subject and body are required",
          },
          400,
        );
      }

      const { data: contact, error: contactError } =
        await supabase
          .from("recruiting_contacts")
          .select("*")
          .eq("id", contactId)
          .single();

      if (contactError || !contact) {
        return json(
          {
            ok: false,
            error: "CRM Contact not found",
          },
          404,
        );
      }

      const universityId =
        Number(contact.university_id);

      if (
        testForceDue &&
        !(universityId >= 900 && universityId <= 999)
      ) {
        return json(
          {
            ok: false,
            error:
              "test_force_due is allowed only for TEST universities.",
          },
          403,
        );
      }

      if (!contact.coach_email) {
        return json(
          {
            ok: false,
            error: "Coach email is missing",
          },
          400,
        );
      }

      if (!contact.gmail_thread_id) {
        return json(
          {
            ok: false,
            error: "Gmail thread ID is missing",
          },
          400,
        );
      }

      if (contact.contact_status !== "responded") {
        return json(
          {
            ok: false,
            error:
              "Conversation Follow-up requires responded status.",
          },
          409,
        );
      }

      const { data: history, error: historyError } =
        await supabase
          .from("recruiting_contact_history")
          .select(
            "event_type,event_at,gmail_message_at,created_at",
          )
          .eq("contact_id", contact.id)
          .in(
            "event_type",
            [
              "reply_received",
              "reply_sent",
              "conversation_follow_up_sent",
            ],
          )
          .order("event_at", { ascending: false });

      if (historyError) {
        throw historyError;
      }

      const normalized =
        (history || [])
          .map((row: any) => ({
            ...row,
            event_time:
              row.gmail_message_at ||
              row.event_at ||
              row.created_at,
          }))
          .filter((row: any) => row.event_time)
          .sort(
            (a: any, b: any) =>
              new Date(b.event_time).getTime() -
              new Date(a.event_time).getTime(),
          );

      const latest = normalized[0];

      if (!latest) {
        return json(
          {
            ok: false,
            error:
              "Reply history is missing. Conversation Follow-up is blocked.",
          },
          409,
        );
      }

      if (latest.event_type === "reply_received") {
        return json(
          {
            ok: false,
            error:
              "A newer Coach reply exists. Conversation Follow-up is blocked.",
          },
          409,
        );
      }

      if (
        ![
          "reply_sent",
          "conversation_follow_up_sent",
        ].includes(latest.event_type)
      ) {
        return json(
          {
            ok: false,
            error:
              "Latest conversation event is not eligible for follow-up.",
          },
          409,
        );
      }

      const latestOutboundAt =
        new Date(latest.event_time);

      const dueAt =
        new Date(
          latestOutboundAt.getTime() +
          7 * 24 * 60 * 60 * 1000,
        );

      if (
        Date.now() < dueAt.getTime() &&
        !testForceDue
      ) {
        return json(
          {
            ok: false,
            error:
              "Conversation Follow-up is not due yet.",
            due_at: dueAt.toISOString(),
          },
          409,
        );
      }

      const token =
        await googleAccessToken();

      const thread =
        await gmailGet(
          `threads/${encodeURIComponent(
            contact.gmail_thread_id,
          )}?format=full`,
          token,
        );

      const messages =
        Array.isArray(thread.messages)
          ? thread.messages
          : [];

      if (!messages.length) {
        return json(
          {
            ok: false,
            error: "Gmail thread contains no messages",
          },
          409,
        );
      }

      // Send直前に、最後のこちらの返信より後のCoach返信を確認。
      const newerInbound = messages.filter((m: any) => {
        const from = emailAddress(
          header(
            m.payload?.headers || [],
            "From",
          ),
        );

        const internalDate =
          Number(m.internalDate || 0);

        return (
          from &&
          from !== GMAIL_ACCOUNT &&
          from ===
            String(contact.coach_email)
              .trim()
              .toLowerCase() &&
          internalDate >
            latestOutboundAt.getTime()
        );
      });

      if (newerInbound.length) {
        await supabase
          .from("recruiting_contacts")
          .update({
            contact_status: "responded",
            next_action: "返信内容を確認",
          })
          .eq("id", contact.id);

        return json(
          {
            ok: false,
            error:
              "A newer Coach reply was detected. Conversation Follow-up was not sent.",
          },
          409,
        );
      }

      const latestMessage =
        messages[messages.length - 1];

      const latestHeaders =
        latestMessage?.payload?.headers || [];

      const messageId =
        header(
          latestHeaders,
          "Message-ID",
        );

      const references =
        header(
          latestHeaders,
          "References",
        );

      const refs =
        [references, messageId]
          .filter(Boolean)
          .join(" ")
          .trim();

      const mime = [
        "To: " +
          cleanHeader(contact.coach_email),

        "From: " + GMAIL_ACCOUNT,

        "Subject: " +
          encodeSubject(subject),

        messageId
          ? "In-Reply-To: " +
            cleanHeader(messageId)
          : "",

        refs
          ? "References: " +
            cleanHeader(refs)
          : "",

        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body,
      ]
        .filter(Boolean)
        .join("\r\n");

      const result =
        await gmailSend(
          base64UrlFromUtf8(mime),
          contact.gmail_thread_id,
          token,
        );

      const sentAt =
        new Date().toISOString();

      const { data: updated, error: updateError } =
        await supabase
          .from("recruiting_contacts")
          .update({
            contact_status: "responded",
            last_contact_at: sentAt,
            contact_count:
              Number(contact.contact_count || 0) + 1,
            next_action:
              "Coachからの次の返信を確認",
            gmail_thread_id:
              result.threadId ||
              contact.gmail_thread_id,
          })
          .eq("id", contact.id)
          .select("*")
          .single();

      if (updateError || !updated) {
        throw new Error(
          "Gmail sent, but CRM update failed: " +
            (
              updateError?.message ||
              "unknown error"
            ),
        );
      }

      const historyInsert =
        await supabase
          .from("recruiting_contact_history")
          .insert({
            owner_user_id:
              updated.owner_user_id,

            contact_id:
              updated.id,

            event_type:
              "conversation_follow_up_sent",

            event_at:
              sentAt,

            note:
              `Conversation Follow-up Gmail送信: ${subject}`,

            to_status:
              "responded",

            gmail_message_id:
              result.id || null,

            gmail_message_at:
              sentAt,
          });

      if (historyInsert.error) {
        console.warn(
          "Conversation Follow-up history insert failed:",
          historyInsert.error,
        );
      }

      // Gmail label sync — TEST universities only for now.
      // Label failure must not turn a successful Conversation
      // Follow-up send into a send failure.
      if (
        universityId >= 900 &&
        universityId <= 999
      ) {
        try {
          await syncRecruitingThreadLabels(
            result.threadId ||
              updated.gmail_thread_id ||
              contact.gmail_thread_id,
            "Recruiting/Waiting Coach",
          );
        } catch (labelError) {
          console.warn(
            "Conversation Follow-up Gmail label sync failed:",
            labelError,
          );
        }
      }

      return json({
        ok: true,
        contact:
          updated,
        gmail_message_id:
          result.id || null,
        gmail_thread_id:
          result.threadId ||
          updated.gmail_thread_id ||
          null,
      });

    } catch (error) {
      console.error(
        "Conversation Follow-up send failed:",
        error,
      );

      return json(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500,
      );
    }
  }),
};
