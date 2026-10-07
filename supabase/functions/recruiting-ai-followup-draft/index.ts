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
      const contactId = safeText(body.contact_id, 100);

      if (!contactId) {
        return json(
          { ok: false, error: "contact_id is required" },
          400,
        );
      }

      const { data: contact, error: contactError } =
        await supabase
          .from("recruiting_contacts")
          .select(`
            id,
            owner_user_id,
            university_id,
            coach_role,
            coach_name,
            coach_email,
            contact_status,
            coach_response,
            follow_up_count
          `)
          .eq("id", contactId)
          .eq("owner_user_id", ownerUserId)
          .maybeSingle();

      if (contactError) throw contactError;

      if (!contact) {
        return json(
          { ok: false, error: "CRM contact not found" },
          404,
        );
      }

      if (
        contact.contact_status === "responded" ||
        safeText(contact.coach_response)
      ) {
        return json(
          {
            ok: false,
            error:
              "Coach reply already exists. Follow-up personalization is blocked.",
          },
          409,
        );
      }

      const followUpCount =
        Number(contact.follow_up_count || 0);

      // Up to two Follow-ups are allowed; prior Research IDs are excluded below.
      if (followUpCount > 1) {
        return json(
          {
            ok: false,
            error:
              "Research personalization is unavailable after the second Follow-up.",
          },
          409,
        );
      }

      const universityId =
        Number(contact.university_id);

      const researchRecipientRole =
        contact.coach_role === "head_coach"
          ? "HC"
          : contact.coach_role === "assistant_coach"
            ? "AC"
            : "";

      if (!researchRecipientRole) {
        return json(
          {
            ok: false,
            error:
              "coach_role must be head_coach or assistant_coach",
          },
          400,
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

      // Collect all Research IDs already used for this contact.
      const { data: history, error: historyError } =
        await supabase
          .from("recruiting_contact_history")
          .select("research_ids")
          .eq("contact_id", contact.id);

      if (historyError) throw historyError;

      const excludedIds = Array.from(
        new Set(
          (history ?? [])
            .flatMap((h: any) =>
              Array.isArray(h.research_ids)
                ? h.research_ids
                : []
            )
            .map((id: unknown) => Number(id))
            .filter(
              (id: number) =>
                Number.isFinite(id) &&
                Number.isInteger(id) &&
                id > 0,
            ),
        ),
      );

      const { data: researchRows, error: researchError } =
        await supabase.rpc(
          "get_personalization_context_excluding",
          {
            p_university_id: universityId,
            p_recipient_role: researchRecipientRole,
            p_recipient_name: safeText(
              contact.coach_name,
              200,
            ),
            p_excluded_ids: excludedIds,
            p_max_facts: 2,
          },
        );

      if (researchError) {
        throw researchError;
      }

      const researchContext = (researchRows ?? []).map(
        (r: any) => ({
          research_id: Number(r.research_id),
          subject_type: safeText(
            r.subject_type,
            50,
          ),
          subject_name: safeText(
            r.subject_name,
            200,
          ),
          fact_type: safeText(
            r.fact_type,
            100,
          ),
          fact_text: safeText(
            r.fact_text,
            2000,
          ),
          personalization_note: safeText(
            r.personalization_note,
            1200,
          ),
          source_url: safeText(
            r.source_url,
            1000,
          ),
          source_title: safeText(
            r.source_title,
            500,
          ),
          reference_rule: safeText(
            r.reference_rule,
            100,
          ),
          priority_score:
            Number(r.priority_score) || 0,
        }),
      );

      if (researchContext.length === 0) {
        return json({
          ok: true,
          model: null,
          contact_id: contact.id,
          university_id: universityId,
          university_name: university.name,
          coach_name: contact.coach_name,
          excluded_research_ids: excludedIds,
          research_context: [],
          draft: {
            personalization_sentence: "",
            rationale_ja:
              "未使用のverified Researchがないため、Follow-up Personalization文は生成していません。",
            research_used: [],
          },
        });
      }

      const prompt = `
You are helping a college soccer student-athlete personalize Follow-up #${followUpCount + 1} of a recruiting email.

Create ONE short, natural English personalization sentence from Akihiro Fujikawa to the coach.

This sentence will be inserted into the next existing Follow-up email.

RULES:
- Use only the verified unused research supplied below.
- Do not invent or infer any fact.
- Preserve the strength and scope of the research fact precisely.
- Do not reuse any previously used research fact.
- Use at most ONE research fact.
- The sentence must work naturally in Follow-up #${followUpCount + 1}, not an initial introduction.
- Keep it concise and conversational.
- Do not repeat generic interest language such as "I remain very interested" because the surrounding Follow-up email already expresses continued interest.
- Prefer a direct program-specific observation such as "I also appreciated..." or "I was particularly interested to see..." when natural.
- Do not sound like a sales brochure.
- Do not imply the coach or program is interested in Akihiro.
- Do not infer scholarship availability, roster openings, positional needs, recruiting priority, or transfer preference.
- Do not claim Akihiro matches a researched quality unless explicitly supported.
- Paraphrase; do not directly quote.
- If reference_rule is "recipient_self", address the coach as "you" or "your".
- If reference_rule is "head_coach_for_ac", it is acceptable to attribute the idea naturally to the head coach.
- If reference_rule is "program", describe it as a program, team, roster, or university fact.
- Never use an AC-specific statement in an email to the HC.
- Prefer the highest-ranked unused research fact unless another supplied fact produces a clearly more natural follow-up sentence.
- Return only the requested structured JSON.

RECIPIENT:
University: ${safeText(university.name, 300)}
Coach name: ${safeText(contact.coach_name, 200)}
Coach role: ${researchRecipientRole}

ALREADY USED RESEARCH IDS:
${JSON.stringify(excludedIds)}

VERIFIED UNUSED RESEARCH:
${JSON.stringify(researchContext, null, 2)}

Create:
1. personalization_sentence: exactly one concise English sentence suitable for Follow-up #${followUpCount + 1}.
2. rationale_ja: brief Japanese explanation.
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
        const timeoutId =
          setTimeout(
            () => controller.abort(),
            12000,
          );

        let response: Response;
        let data: any;

        try {
          response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            {
              method: "POST",
              signal: controller.signal,
              headers: {
                "content-type":
                  "application/json",
                "x-goog-api-key":
                  GEMINI_API_KEY!,
              },
              body: JSON.stringify({
                model,
                input: prompt,
                response_format: {
                  type: "text",
                  mime_type:
                    "application/json",
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
            console.warn(
              lastGeminiError,
            );
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
              error:
                lastGeminiError,
              model_attempted:
                model,
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
            (step: any) =>
              step?.type ===
              "model_output",
          )
          ?.flatMap?.(
            (step: any) =>
              step?.content ?? [],
          )
          ?.find?.(
            (item: any) =>
              item?.type === "text",
          )
          ?.text ??
        geminiData?.outputs?.find?.(
          (x: any) =>
            x?.type === "text",
        )?.text ??
        geminiData?.output?.find?.(
          (x: any) =>
            x?.type === "text",
        )?.text ??
        "";

      if (!outputText) {
        return json(
          {
            ok: false,
            error:
              "Gemini returned no text output",
          },
          502,
        );
      }

      let draft: any;

      try {
        draft =
          JSON.parse(outputText);
      } catch {
        return json(
          {
            ok: false,
            error:
              "Gemini returned invalid JSON",
          },
          502,
        );
      }

      const allowedResearchIds =
        new Set(
          researchContext.map(
            (r: any) =>
              Number(r.research_id),
          ),
        );

      const researchUsed =
        Array.isArray(
          draft.research_used,
        )
          ? draft.research_used
              .map(
                (id: unknown) =>
                  Number(id),
              )
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
              "AI Follow-up personalization did not identify exactly one valid unused research fact",
          },
          502,
        );
      }

      return json({
        ok: true,
        model: modelUsed,
        contact_id: contact.id,
        university_id:
          universityId,
        university_name:
          university.name,
        coach_name:
          contact.coach_name,
        excluded_research_ids:
          excludedIds,
        research_context:
          researchContext,
        draft: {
          personalization_sentence:
            safeText(
              draft.personalization_sentence,
              1000,
            ),
          rationale_ja:
            safeText(
              draft.rationale_ja,
              2000,
            ),
          research_used:
            researchUsed,
        },
      });
    } catch (error) {
      console.error(
        "AI Follow-up personalization draft failed:",
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
