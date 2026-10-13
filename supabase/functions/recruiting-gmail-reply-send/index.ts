import { withSupabase } from "npm:@supabase/server@1";
import { buildReplyRaw, verifyGmailSentBody } from "../_shared/followup-batch-gmail.ts";

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
  throw new Error("Required Gmail reply secrets are not configured.");
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

function header(headers: any[] | undefined, name: string): string {
  return (
    headers?.find(
      (h) =>
        String(h?.name || "").toLowerCase() === name.toLowerCase(),
    )?.value || ""
  );
}

function emailAddress(value: string): string {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match?.[1] || value || "").trim().toLowerCase();
}

async function googleAccessToken(): Promise<string> {
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

  return data.access_token;
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

  if (!response.ok || !data.id) {
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
      return json({ ok: false, error: "POST required" }, 405);
    }

    try {
      const supabase = ctx.supabase;
      const requestBody = await req.json();

      const contactId = String(requestBody.contact_id || "").trim();
      const subject = String(requestBody.subject || "").trim();
      const body = String(requestBody.body || "");

      if (!contactId || !subject || !body.trim()) {
        return json(
          {
            ok: false,
            error: "contact_id, subject and body are required",
          },
          400,
        );
      }

      const { data: contact, error: contactError } =
        await supabase
          .from("recruiting_contacts")
          .select(
            "id,university_id,coach_name,coach_email,coach_role,contact_status,gmail_thread_id",
          )
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
            error: "Gmail Thread ID is missing",
          },
          400,
        );
      }

      if (contact.contact_status !== "responded") {
        return json(
          {
            ok: false,
            error: "CRM Contact is not in responded status",
          },
          409,
        );
      }

      const token = await googleAccessToken();

      const thread = await gmailGet(
        `threads/${encodeURIComponent(
          contact.gmail_thread_id,
        )}?format=full`,
        token,
      );

      const messages = Array.isArray(thread.messages)
        ? thread.messages
        : [];

      if (!messages.length) {
        return json(
          {
            ok: false,
            error: "Gmail thread contains no messages",
          },
          404,
        );
      }

      const inbound = messages
        .filter((message: any) => {
          const from = emailAddress(
            header(message.payload?.headers, "From"),
          );

          return (
            from &&
            from !== GMAIL_ACCOUNT &&
            from ===
              String(contact.coach_email)
                .trim()
                .toLowerCase()
          );
        })
        .sort(
          (a: any, b: any) =>
            Number(a.internalDate || 0) -
            Number(b.internalDate || 0),
        );

      if (!inbound.length) {
        return json(
          {
            ok: false,
            error:
              "No inbound Coach message was found in the Gmail thread",
          },
          409,
        );
      }

      const latest = inbound[inbound.length - 1];
      const headers = latest.payload?.headers || [];

      const messageId = header(headers, "Message-ID");
      const references = header(headers, "References");

      if (!messageId) {
        return json(
          {
            ok: false,
            error:
              "Latest Coach message does not contain Message-ID",
          },
          409,
        );
      }

      const raw = buildReplyRaw({ to: contact.coach_email, subject, body, messageId, references });
      const result = await gmailSend(
        raw,
        contact.gmail_thread_id,
        token,
      );

      // Gmail has accepted this message. A failed readback must never invite a resend.
      let bodyVerified = false;
      try {
        await verifyGmailSentBody(result.id, body, token);
        bodyVerified = true;
      } catch {
        console.warn("Reply accepted by Gmail; sent body requires manual verification.");
      }

      // Gmail label sync.
      // Label failure must not turn a successful reply send
      // into a send failure.
      try {
        await syncRecruitingThreadLabels(
          result.threadId ||
            contact.gmail_thread_id,
          "Recruiting/Waiting Coach",
        );
      } catch (labelError) {
        console.warn(
          "Reply Gmail label sync failed:",
          labelError,
        );
      }

      return json({
        ok: true,
        body_verified: bodyVerified,
        contact_id: contact.id,
        university_id: contact.university_id,
        coach_role: contact.coach_role,
        gmail_message_id: result.id || null,
        gmail_thread_id:
          result.threadId ||
          contact.gmail_thread_id,
      });
    } catch (error) {
      console.error(
        "Phase 9-C Gmail reply send failed:",
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
