import { withSupabase } from "npm:@supabase/server@1";

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

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

      const followUpNumber =
        Number(payload.follow_up_number);

      const researchIds =
        followUpNumber === 1 &&
        Array.isArray(payload.research_ids)
          ? payload.research_ids
              .map((id: unknown) => Number(id))
              .filter((id: number) =>
                Number.isFinite(id) &&
                Number.isInteger(id) &&
                id > 0
              )
              .slice(0, 1)
          : [];

      if (
        !contactId ||
        !subject ||
        !body.trim() ||
        ![1, 2].includes(followUpNumber)
      ) {
        return json(
          {
            ok: false,
            error:
              "contact_id, subject, body and follow_up_number (1 or 2) are required",
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

      if (contact.contact_status === "responded") {
        return json(
          {
            ok: false,
            error:
              "Coach reply already exists. Follow-up is blocked.",
          },
          409,
        );
      }

      const currentFollowUpCount =
        Number(contact.follow_up_count || 0);

      const expectedFollowUpNumber =
        currentFollowUpCount + 1;

      if (followUpNumber !== expectedFollowUpNumber) {
        return json(
          {
            ok: false,
            error:
              `Follow-up sequence mismatch. Expected #${expectedFollowUpNumber}.`,
          },
          409,
        );
      }

      if (followUpNumber > 2) {
        return json(
          {
            ok: false,
            error:
              "Maximum Follow-up count has already been reached.",
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

      // Immediately before sending, verify that
      // a real coach reply has not appeared.
      const inbound = messages.filter((m: any) => {
        const from = emailAddress(
          header(
            m.payload?.headers || [],
            "From",
          ),
        );

        return (
          from &&
          from !== GMAIL_ACCOUNT &&
          from ===
            String(contact.coach_email)
              .trim()
              .toLowerCase()
        );
      });

      if (inbound.length) {
        await supabase
          .from("recruiting_contacts")
          .update({
            contact_status: "responded",
            follow_up_date: null,
            auto_follow_up_enabled: false,
            next_action: "返信内容を確認",
          })
          .eq("id", contact.id);

        return json(
          {
            ok: false,
            error:
              "Coach reply detected. Follow-up was not sent.",
          },
          409,
        );
      }

      const latest =
        messages[messages.length - 1];

      const latestHeaders =
        latest?.payload?.headers || [];

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

      const exhausted =
        followUpNumber >= 2;

      const nextFollowUpDate =
        exhausted
          ? null
          : addDays(new Date(), 7);

      const newStatus =
        exhausted
          ? "no_response"
          : "contacted";

      const { data: updated, error: updateError } =
        await supabase
          .from("recruiting_contacts")
          .update({
            contact_status: newStatus,
            last_contact_at: sentAt,
            contact_count:
              Number(contact.contact_count || 0) + 1,
            follow_up_count:
              followUpNumber,
            last_follow_up_at:
              sentAt,
            follow_up_date:
              nextFollowUpDate,
            auto_follow_up_enabled:
              !exhausted,
            next_action:
              exhausted
                ? "2回フォローアップ済み・返信なし"
                : "次回フォローアップメール送信",
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

      const history =
        await supabase
          .from(
            "recruiting_contact_history",
          )
          .insert({
            owner_user_id:
              updated.owner_user_id,

            contact_id:
              updated.id,

            event_type:
              "follow_up_sent",

            event_at:
              sentAt,

            note:
              `Follow-up #${followUpNumber} Gmail送信: ${subject}`,

            to_status:
              newStatus,

            gmail_message_id:
              result.id || null,

            gmail_message_at:
              sentAt,

            research_ids:
              researchIds,
          });

      if (history.error) {
        console.warn(
          "Manual Follow-up history insert failed:",
          history.error,
        );
      }

      return json({
        ok: true,
        follow_up_number:
          followUpNumber,
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
        "Manual server Follow-up failed:",
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
