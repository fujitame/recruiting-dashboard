import { withSupabase } from "npm:@supabase/server@1";

import {
  chooseRecruitingStateLabel,
  syncRecruitingThreadLabels,
} from "../_shared/recruiting-gmail-labels.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type",
    },
  });
}

export default {
  fetch: withSupabase(
    { auth: "user" },
    async (req, ctx) => {
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
        const ownerUserId = String(
          ctx.jwtClaims?.sub ??
          ctx.userClaims?.sub ??
          "",
        );

        if (
          ownerUserId !==
          "47e7c1a9-a806-4f65-b5ed-2b9b124ef337"
        ) {
          return json(
            { ok: false, error: "Unauthorized" },
            403,
          );
        }

        const payload =
          await req.json();

        const contactId =
          String(
            payload.contact_id || "",
          ).trim();

        if (!contactId) {
          return json(
            {
              ok: false,
              error:
                "contact_id is required",
            },
            400,
          );
        }

        const supabase =
          ctx.supabase;

        const {
          data: contact,
          error: contactError,
        } = await supabase
          .from(
            "recruiting_contacts",
          )
          .select(`
            id,
            owner_user_id,
            university_id,
            coach_name,
            coach_email,
            contact_status,
            coach_response,
            gmail_thread_id
          `)
          .eq("id", contactId)
          .single();

        if (
          contactError ||
          !contact
        ) {
          return json(
            {
              ok: false,
              error:
                "CRM Contact not found",
            },
            404,
          );
        }

        const universityId =
          Number(
            contact.university_id,
          );


        if (
          !contact.gmail_thread_id
        ) {
          return json(
            {
              ok: false,
              error:
                "Gmail thread ID is missing",
            },
            400,
          );
        }

        const {
          data: history,
          error: historyError,
        } = await supabase
          .from(
            "recruiting_contact_history",
          )
          .select(`
            event_type,
            event_at,
            created_at,
            gmail_message_at
          `)
          .eq(
            "contact_id",
            contact.id,
          )
          .in(
            "event_type",
            [
              "reply_received",
              "reply_sent",
              "conversation_follow_up_sent",
            ],
          );

        if (historyError) {
          throw historyError;
        }

        const targetLabel =
          chooseRecruitingStateLabel(
            contact,
            history || [],
          );

        await syncRecruitingThreadLabels(
          contact.gmail_thread_id,
          targetLabel,
        );

        return json({
          ok: true,
          university_id:
            universityId,
          coach_name:
            contact.coach_name,
          contact_status:
            contact.contact_status,
          target_label:
            targetLabel,
          thread_id:
            contact.gmail_thread_id,
        });
      } catch (error) {
        console.error(
          "Recruiting Gmail label sync failed:",
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
    },
  ),
};
