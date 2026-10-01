import { withSupabase } from "npm:@supabase/server@1";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
if (!GEMINI_API_KEY) {
  throw new Error("Required Phase 9-C secrets are not configured.");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}

function safeText(value: unknown, max = 6000) {
  return String(value ?? "").trim().slice(0, max);
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }

    if (req.method !== "POST") {
      return json({ ok: false, error: "POST required" }, 405);
    }

    try {
      const supabase = ctx.supabase;
      const ownerUserId = String(
        ctx.jwtClaims?.sub ??
        ctx.userClaims?.sub ??
        ""
      );

      if (!ownerUserId) {
        return json({ ok: false, error: "Authenticated user id missing" }, 401);
      }

      const body = await req.json();

    const universityId = Number(body.university_id);
    const coachRole = safeText(body.coach_role, 50);

    if (!Number.isFinite(universityId) || !coachRole) {
      return json({
        ok: false,
        error: "university_id and coach_role are required",
      }, 400);
    }

    const { data: contact, error: contactError } = await supabase
      .from("recruiting_contacts")
      .select(`
        id,
        owner_user_id,
        university_id,
        coach_role,
        coach_name,
        coach_email,
        coach_response,
        contact_status,
        interest_level,
        interest_reason
      `)
      .eq("owner_user_id", ownerUserId)
      .eq("university_id", universityId)
      .eq("coach_role", coachRole)
      .maybeSingle();

    if (contactError) throw contactError;
    if (!contact) {
      return json({ ok: false, error: "CRM contact not found" }, 404);
    }

    if (!safeText(contact.coach_response)) {
      return json({ ok: false, error: "Coach response is empty" }, 400);
    }

    const { data: history, error: historyError } = await supabase
      .from("recruiting_contact_history")
      .select("event_type,event_at,note")
      .eq("contact_id", contact.id)
      .order("event_at", { ascending: false })
      .limit(8);

    if (historyError) throw historyError;

    const player = {
      name: "Akihiro Fujikawa",
      current_school: "Harcum College",
      division: "NJCAA Division I",
      jersey: "#14",
      primary_position: "Left Side Half / Winger",
      secondary_positions: "Right Side Half / Fullback",
      transfer_target: "Fall 2027",
      gpa: "3.28",
      profile_url: "https://fujitame.github.io/profile/",
      highlight_video: "https://youtu.be/GYwZrTe9pqw",
      email: "fujiakihiro8@gmail.com",
      phone: "+1 610-529-3326",
      instagram: "@a93914",
    };

    const historySummary = (history ?? []).map((h: any) => ({
      event_type: h.event_type,
      event_at: h.event_at,
      note: safeText(h.note, 1200),
    }));

    const prompt = `
You are assisting a college soccer student-athlete with recruiting email replies.

Write a concise, natural English reply from Akihiro Fujikawa to the coach.

RULES:
- Do not invent facts.
- Only use facts provided below.
- Directly answer or acknowledge the coach's request.
- Sound like a real college student, not a sales brochure.
- Be polite, confident, concise, and warm.
- Do not overstate interest from the coach.
- Do not promise documents, dates, visits, eligibility, offers, or actions unless supported.
- If the coach asks for something that is not confirmed as available, acknowledge the request without falsely claiming it has already been sent.
- Do not include commentary about AI.
- Do not include markdown.
- Return only the requested structured JSON.

COACH / CRM:
Coach name: ${safeText(contact.coach_name)}
Coach email: ${safeText(contact.coach_email)}
Coach role: ${safeText(contact.coach_role)}
University ID: ${contact.university_id}
Current CRM status: ${safeText(contact.contact_status)}
Interest level: ${safeText(contact.interest_level)}
Interest reason: ${safeText(contact.interest_reason)}

LATEST COACH REPLY:
${safeText(contact.coach_response)}

PLAYER:
${JSON.stringify(player, null, 2)}

RECENT CONTACT HISTORY:
${JSON.stringify(historySummary, null, 2)}

Create:
1. subject: appropriate email subject, normally preserving a reply-style subject.
2. body: ready-to-edit English reply email.
3. rationale_ja: short Japanese explanation of why this reply is appropriate.
4. requested_items: list of concrete items/actions the coach requested, if any.
`;

    const models = [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
    ];

    let geminiResponse: Response | null = null;
    let geminiData: any = null;
    let modelUsed = "";
    let lastGeminiError = "";

    for (const model of models) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      let response: Response;
      let data: any;

      try {
        response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY!,
            },
            body: JSON.stringify({
            model,
            input: prompt,
            response_format: {
              type: "text",
              mime_type: "application/json",
              schema: {
                type: "object",
                properties: {
                  subject: {
                    type: "string",
                  },
                  body: {
                    type: "string",
                  },
                  rationale_ja: {
                    type: "string",
                  },
                  requested_items: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                  },
                },
                required: [
                  "subject",
                  "body",
                  "rationale_ja",
                  "requested_items",
                ],
              },
            },
            }),
          },
        );

        data = await response.json();
      } catch (error) {
        const isAbort =
          error instanceof Error &&
          error.name === "AbortError";

        if (isAbort) {
          lastGeminiError =
            `${model} timed out after 12 seconds`;

          console.warn(lastGeminiError);
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) {
        geminiResponse = response;
        geminiData = data;
        modelUsed = model;
        break;
      }

      lastGeminiError =
        data?.error?.message ||
        `Gemini API error: ${response.status}`;

      console.warn(
        `Gemini model ${model} failed:`,
        response.status,
        lastGeminiError,
      );

      const retryable =
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        /high demand|temporar|overload|capacity/i.test(lastGeminiError);

      if (!retryable) {
        return json({
          ok: false,
          error: lastGeminiError,
          model_attempted: model,
        }, 502);
      }
    }

    if (!geminiResponse || !geminiData || !modelUsed) {
      return json({
        ok: false,
        error:
          lastGeminiError ||
          "All Gemini Flash models were temporarily unavailable",
        models_attempted: models,
      }, 502);
    }

    const outputText =
      geminiData?.output_text ??
      geminiData?.steps
        ?.filter?.((step: any) => step?.type === "model_output")
        ?.flatMap?.((step: any) => step?.content ?? [])
        ?.find?.((item: any) => item?.type === "text")
        ?.text ??
      geminiData?.outputs?.find?.((x: any) => x?.type === "text")?.text ??
      geminiData?.output?.find?.((x: any) => x?.type === "text")?.text ??
      "";

    if (!outputText) {
      console.error("Gemini response did not contain output_text:", geminiData);
      return json({
        ok: false,
        error: "Gemini returned no text output",
      }, 502);
    }

    let draft;
    try {
      draft = JSON.parse(outputText);
    } catch {
      console.error("Gemini JSON parse failed:", outputText);
      return json({
        ok: false,
        error: "Gemini returned invalid JSON",
      }, 502);
    }

    return json({
      ok: true,
      model: modelUsed,
      contact_id: contact.id,
      university_id: contact.university_id,
      coach_role: contact.coach_role,
      coach_name: contact.coach_name,
      draft,
    });
  } catch (error) {
    console.error("Phase 9-C AI reply draft failed:", error);

    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
    }
  }),
};
