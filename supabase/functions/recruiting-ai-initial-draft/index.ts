import { withSupabase } from "npm:@supabase/server@1";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured.");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type",
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
          "access-control-allow-headers":
            "authorization, x-client-info, apikey, content-type",
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
        "",
      );

      if (!ownerUserId) {
        return json(
          { ok: false, error: "Authenticated user id missing" },
          401,
        );
      }

      const body = await req.json();

      const universityId = Number(body.university_id);
      const coachRole = safeText(body.coach_role, 50);

      if (!Number.isFinite(universityId) || !coachRole) {
        return json(
          {
            ok: false,
            error: "university_id and coach_role are required",
          },
          400,
        );
      }

      const researchRecipientRole =
        coachRole === "head_coach"
          ? "HC"
          : coachRole === "assistant_coach"
            ? "AC"
            : coachRole;

      if (!["HC", "AC"].includes(researchRecipientRole)) {
        return json(
          {
            ok: false,
            error: "coach_role must be head_coach or assistant_coach",
          },
          400,
        );
      }

      const { data: contact, error: contactError } = await supabase
        .from("recruiting_contacts")
        .select(`
          id,
          owner_user_id,
          university_id,
          coach_role,
          coach_name,
          coach_email
        `)
        .eq("owner_user_id", ownerUserId)
        .eq("university_id", universityId)
        .eq("coach_role", coachRole)
        .maybeSingle();

      if (contactError) throw contactError;

      if (!contact) {
        return json(
          { ok: false, error: "CRM contact not found" },
          404,
        );
      }

      const { data: university, error: universityError } =
        await supabase
          .from("recruiting_universities")
          .select("id,name")
          .eq("id", universityId)
          .single();

      if (universityError || !university) {
        return json(
          { ok: false, error: "University not found" },
          404,
        );
      }

      const { data: researchRows, error: researchError } =
        await supabase.rpc(
          "get_personalization_context",
          {
            p_university_id: universityId,
            p_recipient_role: researchRecipientRole,
            p_recipient_name: safeText(contact.coach_name, 200),
            p_max_facts: 2,
          },
        );

      if (researchError) {
        throw researchError;
      }

      const researchContext = (researchRows ?? []).map((r: any) => ({
        selection_rank: r.selection_rank,
        research_id: r.research_id,
        subject_type: safeText(r.subject_type, 50),
        subject_name: safeText(r.subject_name, 200),
        fact_type: safeText(r.fact_type, 100),
        fact_text: safeText(r.fact_text, 2000),
        personalization_note: safeText(
          r.personalization_note,
          1200,
        ),
        source_url: safeText(r.source_url, 1000),
        source_title: safeText(r.source_title, 500),
        reference_rule: safeText(r.reference_rule, 100),
        priority_score: Number(r.priority_score) || 0,
      }));

      // Researchが無い大学では無理にAI文章を作らない。
      if (researchContext.length === 0) {
        return json({
          ok: true,
          model: null,
          university_id: universityId,
          university_name: university.name,
          coach_role: coachRole,
          coach_name: contact.coach_name,
          research_context: [],
          draft: {
            personalization_sentence: "",
            rationale_ja:
              "利用可能なverified Researchがないため、Personalization文は生成していません。",
            research_used: [],
          },
        });
      }

      const prompt = `
You are helping a college soccer student-athlete personalize an initial recruiting email.

Create ONE short, natural English personalization sentence for an initial recruiting email from Akihiro Fujikawa to the coach.

The sentence will be inserted immediately after Akihiro says he is interested in transferring to the university.

RULES:
- Use only the verified research supplied below.
- Do not invent or infer any fact.
- Preserve the strength and scope of the research fact precisely.
- Do not strengthen wording such as "fits the style" into "core", "central", "key philosophy", "priority", or similar claims unless the research explicitly says so.
- Use at most ONE research fact in the sentence.
- The sentence should sound natural, specific, and concise.
- Do not sound like a sales brochure or like extensive research was performed.
- Do not claim that the program is interested in Akihiro.
- Do not claim a scholarship, roster opening, positional need, recruiting priority, or transfer preference unless explicitly stated in the supplied fact.
- Do not claim Akihiro matches a researched quality. This function is only generating the program-specific sentence.
- Paraphrase. Do not use a direct quotation.
- If reference_rule is "recipient_self", address the coach as "you" or "your". Do not refer to that coach in the third person.
- If reference_rule is "head_coach_for_ac", it is acceptable to naturally attribute the idea to the head coach.
- If reference_rule is "program", describe the fact as a program, team, roster, or university fact.
- Never use an AC-specific statement in an email to the HC.
- Prefer the highest-ranked research fact unless another supplied fact produces a clearly more natural sentence.
- Return only the requested structured JSON.

RECIPIENT:
University: ${safeText(university.name, 300)}
Coach name: ${safeText(contact.coach_name, 200)}
Coach role: ${researchRecipientRole}

VERIFIED PERSONALIZATION RESEARCH:
${JSON.stringify(researchContext, null, 2)}

Create:
1. personalization_sentence: exactly one concise English sentence.
2. rationale_ja: brief Japanese explanation of why this fact was selected and how it was phrased.
3. research_used: array containing the single research_id actually used.
`;

      const models = [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
      ];

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
                      personalization_sentence: {
                        type: "string",
                      },
                      rationale_ja: {
                        type: "string",
                      },
                      research_used: {
                        type: "array",
                        items: {
                          type: "integer",
                        },
                      },
                    },
                    required: [
                      "personalization_sentence",
                      "rationale_ja",
                      "research_used",
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
          /high demand|temporar|overload|capacity/i.test(
            lastGeminiError,
          );

        if (!retryable) {
          return json(
            {
              ok: false,
              error: lastGeminiError,
              model_attempted: model,
            },
            502,
          );
        }
      }

      if (!geminiData || !modelUsed) {
        return json(
          {
            ok: false,
            error:
              lastGeminiError ||
              "All Gemini Flash models were temporarily unavailable",
            models_attempted: models,
          },
          502,
        );
      }

      const outputText =
        geminiData?.output_text ??
        geminiData?.steps
          ?.filter?.(
            (step: any) => step?.type === "model_output",
          )
          ?.flatMap?.((step: any) => step?.content ?? [])
          ?.find?.((item: any) => item?.type === "text")
          ?.text ??
        geminiData?.outputs?.find?.(
          (x: any) => x?.type === "text",
        )?.text ??
        geminiData?.output?.find?.(
          (x: any) => x?.type === "text",
        )?.text ??
        "";

      if (!outputText) {
        console.error(
          "Gemini response did not contain output_text:",
          geminiData,
        );

        return json(
          {
            ok: false,
            error: "Gemini returned no text output",
          },
          502,
        );
      }

      let draft: any;

      try {
        draft = JSON.parse(outputText);
      } catch {
        console.error(
          "Gemini JSON parse failed:",
          outputText,
        );

        return json(
          {
            ok: false,
            error: "Gemini returned invalid JSON",
          },
          502,
        );
      }

      const allowedResearchIds = new Set(
        researchContext.map((r: any) =>
          Number(r.research_id)
        ),
      );

      const researchUsed = Array.isArray(draft.research_used)
        ? draft.research_used
            .map((id: unknown) => Number(id))
            .filter(
              (id: number) =>
                Number.isFinite(id) &&
                allowedResearchIds.has(id),
            )
            .slice(0, 1)
        : [];

      if (researchUsed.length !== 1) {
        return json(
          {
            ok: false,
            error:
              "AI personalization did not identify exactly one valid research fact",
          },
          502,
        );
      }

      return json({
        ok: true,
        model: modelUsed,
        university_id: universityId,
        university_name: university.name,
        coach_role: coachRole,
        coach_name: contact.coach_name,
        research_context: researchContext,
        draft: {
          personalization_sentence: safeText(
            draft.personalization_sentence,
            1000,
          ),
          rationale_ja: safeText(
            draft.rationale_ja,
            2000,
          ),
          research_used: researchUsed,
        },
      });
    } catch (error) {
      console.error(
        "AI initial personalization draft failed:",
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
