import { withSupabase } from "npm:@supabase/server@1";
import { buildReplyRaw, verifyGmailSentBody } from "../_shared/followup-batch-gmail.ts";

import {
  syncContactThreadLabels,
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

async function gmailSend(raw: string, token: string) {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
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

    let acceptedMessage: any = null;
    try {
      const supabase = ctx.supabase;
      const requestBody = await req.json();

      const contactId = String(requestBody.contact_id || "").trim();
      const subject = String(requestBody.subject || "").trim();
      const body = String(requestBody.body || "");

      const researchIds = Array.isArray(requestBody.research_ids)
        ? requestBody.research_ids
            .map((id: unknown) => Number(id))
            .filter((id: number) =>
              Number.isFinite(id) &&
              Number.isInteger(id) &&
              id > 0
            )
            .slice(0, 2)
        : [];

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
          .select("*")
          .eq("id", contactId)
          .single();

      if (contactError || !contact) {
        return json(
          { ok: false, error: "CRM Contact not found" },
          404,
        );
      }

      if(contact.contact_status!=='not_contacted'||Number(contact.follow_up_count||0)!==0||contact.gmail_thread_id||String(contact.coach_response||'').trim())return json({ok:false,error:'Initial email has already been sent or this contact is no longer eligible.'},409);
      const universityId = Number(contact.university_id);

      if (!contact.coach_email) {
        return json(
          { ok: false, error: "Coach email is missing" },
          400,
        );
      }

      const raw = buildReplyRaw({ to: contact.coach_email, subject, body, messageId: "", references: "" });

      const token = await googleAccessToken();

      const result = await gmailSend(
        raw,
        token,
      );

      acceptedMessage = result;

      // Record an accepted send even if readback fails; never suggest a blind retry.
      let bodyVerified = false;
      try {
        await verifyGmailSentBody(result.id, body, token);
        bodyVerified = true;
      } catch {
        console.warn("Initial email accepted by Gmail; sent body requires manual verification.");
      }

      const now = new Date();
      const sentAt = now.toISOString();

      const follow = new Date(
        now.getTime() + 7 * 86400000,
      ).toISOString().slice(0, 10);

      const { data: updated, error: updateError } =
        await supabase
          .from("recruiting_contacts")
          .update({
            contact_status: "contacted",
            last_contact_at: sentAt,
            contact_count: Number(contact.contact_count || 0) + 1,
            follow_up_count: 0,
            last_follow_up_at: null,
            follow_up_date: bodyVerified ? follow : null,
            auto_follow_up_enabled: bodyVerified,
            next_action: bodyVerified ? "次回フォローアップメール送信" : "送信本文の確認が必要 — 再送せずGmailを確認",
            gmail_thread_id:
              result.threadId ||
              contact.gmail_thread_id ||
              null,
          })
          .eq("id", contact.id)
          .select("*")
          .single();

      if (updateError || !updated) {
        throw new Error(
          "Gmail sent, but CRM update failed: " +
            (updateError?.message || "unknown error"),
        );
      }

      const history = await supabase
        .from("recruiting_contact_history")
        .insert({
          owner_user_id: updated.owner_user_id,
          contact_id: updated.id,
          event_type: "contact_logged",
          event_at: sentAt,
          note: "Gmail送信: " + subject + (bodyVerified ? "" : " — 本文未検証。再送せずGmailを確認"),
          to_status: "contacted",
          gmail_message_id: result.id || null,
          gmail_message_at: sentAt,
          research_ids: researchIds,
        });

      if (history.error) {
        console.warn(
          "Initial Gmail history insert failed:",
          history.error,
        );
      }

      // Gmail label sync.
      // Label failure must never make a successfully sent email
      // appear as a send failure.
      if (
        result.threadId ||
        updated.gmail_thread_id
      ) {
        try {
          await syncContactThreadLabels(supabase,updated);
        } catch (labelError) {
          console.warn(
            "Initial Gmail label sync failed:",
            labelError,
          );
        }
      }

      return json({
        ok: true,
        body_verified: bodyVerified,
        contact: updated,
        gmail_message_id: result.id || null,
        gmail_thread_id:
          result.threadId ||
          updated.gmail_thread_id ||
          null,
      });
    } catch (error) {
      console.error(
        "Server initial Gmail send failed:",
        error,
      );

      return json(
        {
          ok: false,
          sent: !!acceptedMessage?.id,
          gmail_message_id: acceptedMessage?.id || null,
          gmail_thread_id: acceptedMessage?.threadId || null,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        acceptedMessage?.id ? 200 : 500,
      );
    }
  }),
};
