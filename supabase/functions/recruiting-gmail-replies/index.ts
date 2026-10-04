import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  syncRecruitingThreadLabels,
} from "../_shared/recruiting-gmail-labels.ts";

const GMAIL_ACCOUNT =
  (Deno.env.get("GMAIL_ACCOUNT") ?? "fujiakihiro8@gmail.com")
    .trim()
    .toLowerCase();

const GOOGLE_CLIENT_ID =
  Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");

const GOOGLE_CLIENT_SECRET =
  Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");

const GOOGLE_REFRESH_TOKEN =
  Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL");

const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REFRESH_TOKEN ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error(
    "Required recruiting-gmail-replies secrets are not configured.",
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

const REPLY_DETECTOR_SECRET =
  Deno.env.get("RECRUITING_REPLY_DETECTOR_SECRET")
    ?.trim();

async function isAuthorized(
  req: Request,
): Promise<boolean> {

  const suppliedSecret =
    req.headers
      .get("x-recruiting-secret")
      ?.trim();

  if (
    REPLY_DETECTOR_SECRET &&
    suppliedSecret &&
    suppliedSecret === REPLY_DETECTOR_SECRET
  ) {
    return true;
  }

  const authorization =
    req.headers.get("authorization") ?? "";

  const match =
    authorization.match(
      /^Bearer\s+(.+)$/i,
    );

  if (!match) {
    return false;
  }

  const {
    data,
    error,
  } =
    await supabase.auth.getUser(
      match[1],
    );

  return (
    !error &&
    data.user?.id ===
      "47e7c1a9-a806-4f65-b5ed-2b9b124ef337"
  );
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, x-recruiting-secret",
  "access-control-allow-methods":
    "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        ...CORS_HEADERS,
      },
    },
  );
}

function decodeBase64Url(value: string): string {
  const normalized =
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const padded =
    normalized +
    "=".repeat(
      (4 - (normalized.length % 4)) % 4,
    );

  try {
    return new TextDecoder().decode(
      Uint8Array.from(
        atob(padded),
        c => c.charCodeAt(0),
      ),
    );
  } catch {
    return "";
  }
}

function header(
  headers: any[] | undefined,
  name: string,
): string {
  return (
    headers?.find(
      h =>
        String(h.name || "")
          .toLowerCase() ===
        name.toLowerCase(),
    )?.value ?? ""
  );
}

function emailAddress(value: string): string {
  const match =
    String(value || "")
      .match(/<([^>]+)>/);

  return (
    match?.[1] ??
    value ??
    ""
  )
    .trim()
    .toLowerCase();
}

function collectText(part: any): string {
  if (!part) return "";

  if (
    part.mimeType === "text/plain" &&
    part.body?.data
  ) {
    return decodeBase64Url(
      part.body.data,
    );
  }

  if (
    part.mimeType === "text/html" &&
    part.body?.data
  ) {
    return decodeBase64Url(
      part.body.data,
    );
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const text =
        collectText(child);

      if (text) return text;
    }
  }

  return "";
}

function cleanReplyText(
  value: string,
): string {
  let text =
    String(value || "")
      .replace(
        /<br\s*\/?>/gi,
        "\n",
      )
      .replace(
        /<\/p\s*>/gi,
        "\n",
      )
      .replace(
        /<[^>]+>/g,
        "",
      )
      .replace(
        /&nbsp;/gi,
        " ",
      )
      .replace(
        /&lt;/gi,
        "<",
      )
      .replace(
        /&gt;/gi,
        ">",
      )
      .replace(
        /&amp;/gi,
        "&",
      )
      .replace(
        /\r\n/g,
        "\n",
      )
      .replace(
        /\r/g,
        "\n",
      );

  const lines =
    text.split("\n");

  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const trimmed =
      line.trim();

    if (/^>/.test(trimmed)) break;

    if (
      /^-{2,}\s*Original Message\s*-{2,}$/i
        .test(trimmed)
    ) {
      break;
    }

    if (
      /^On .+ wrote:$/i
        .test(trimmed)
    ) {
      break;
    }

    if (
      /^20\d{2}\/\d{1,2}\/\d{1,2}.+メール:$/i
        .test(trimmed)
    ) {
      break;
    }

    // Outlook / Microsoft 365 replies often append the original
    // message using a From / Date(or Sent) / To / Subject block.
    // Detect the whole header pattern rather than cutting on any
    // standalone "From:" text in the coach's reply.
    if (/^From:\s*/i.test(trimmed)) {
      const nextNonEmpty =
        lines
          .slice(i, i + 12)
          .map(v => v.trim())
          .filter(Boolean);

      const hasDateOrSent =
        nextNonEmpty.some(v =>
          /^(Date|Sent):\s*/i.test(v)
        );

      const hasTo =
        nextNonEmpty.some(v =>
          /^To:\s*/i.test(v)
        );

      const hasSubject =
        nextNonEmpty.some(v =>
          /^Subject:\s*/i.test(v)
        );

      if (
        hasDateOrSent &&
        hasTo &&
        hasSubject
      ) {
        break;
      }
    }

    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(
      /\n{3,}/g,
      "\n\n",
    )
    .trim();
}

function classifyInterest(
  text: string,
) {
  const s =
    String(text || "")
      .toLowerCase();

  const high = [
    "interested in akihiro",
    "interested in your profile",
    "interested in your player",
    "interested in recruiting",
    "would like to learn more",
    "would like to discuss",
    "let's discuss",
    "let us discuss",
    "schedule a call",
    "schedule a meeting",
    "set up a call",
    "send me his highlight",
    "send his highlight",
    "send your transcript",
    "send me your transcript",
    "send me his transcript",
    "full match",
    "full-match",
    "match video",
    "game film",
    "send more information",
    "send more info",
    "good fit",
    "great fit",
    "strong fit",
    "could be a good fit",
    "we are interested",
    "we're interested",
    "interested in having him",
    "interested in having you",
    "transfer candidate",
    "transfer opportunity",
    "visit campus",
    "official visit",
    "unofficial visit",
    "id camp",
    "idcamp",
  ];

  const medium = [
    "keep me posted",
    "keep us posted",
    "please follow up",
    "feel free to reach out",
    "let me know",
    "send your profile",
    "send your information",
    "send more",
    "happy to connect",
    "open to a conversation",
    "tell me more",
    "more information",
    "more details",
    "thanks for reaching out",
    "thank you for reaching out",
  ];

  const low = [
    "not recruiting",
    "not looking",
    "no roster spots",
    "no room",
    "already full",
    "not a fit",
    "unable to",
    "cannot offer",
    "can't offer",
    "not interested",
    "does not accept transfers",
    "do not accept transfers",
    "doesn't accept transfers",
    "cannot accept transfers",
    "can't accept transfers",
    "good luck with your transfer",
    "best of luck",
    "remove me",
    "players ahead of you",
  ];

  const hits =
    (terms: string[]) =>
      terms.filter(
        term =>
          s.includes(term),
      );

  const h = hits(high);
  const m = hits(medium);
  const l = hits(low);

  if (
    l.length &&
    !h.length
  ) {
    return {
      level: "low",
      reason:
        "否定・優先順位が低いことを示す表現を検出: " +
        l.slice(0, 3).join(", "),
    };
  }

  if (h.length) {
    return {
      level: "high",
      reason:
        "具体的な関心・次のアクションを示す表現を検出: " +
        h.slice(0, 3).join(", "),
    };
  }

  if (m.length) {
    return {
      level: "medium",
      reason:
        "前向きな接点継続を示す表現を検出: " +
        m.slice(0, 3).join(", "),
    };
  }

  return {
    level: "unknown",
    reason:
      "明確な関心表現を検出できませんでした。",
  };
}

async function getGmailAccessToken():
  Promise<string> {

  const body =
    new URLSearchParams({
      client_id:
        GOOGLE_CLIENT_ID!,
      client_secret:
        GOOGLE_CLIENT_SECRET!,
      refresh_token:
        GOOGLE_REFRESH_TOKEN!,
      grant_type:
        "refresh_token",
    });

  const response =
    await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
        },
        body,
      },
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    throw new Error(
      data.error_description ||
      data.error ||
      "Unable to refresh Google access token.",
    );
  }

  return data.access_token;
}

async function gmailGet(
  path: string,
  token: string,
) {
  const response =
    await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/" +
        path,
      {
        headers: {
          Authorization:
            "Bearer " + token,
        },
      },
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      `Gmail API error: ${response.status}`,
    );
  }

  return data;
}

async function listRecentInboundMessages(
  token: string,
) {
  const messages: Array<{
    id: string;
    threadId: string;
  }> = [];

  let pageToken = "";
  let pages = 0;

  const query =
    `newer_than:14d -from:${GMAIL_ACCOUNT}`;

  while (pages < 5) {
    const params =
      new URLSearchParams({
        q: query,
        maxResults: "100",
      });

    if (pageToken) {
      params.set(
        "pageToken",
        pageToken,
      );
    }

    const data =
      await gmailGet(
        `messages?${params.toString()}`,
        token,
      );

    if (
      Array.isArray(data.messages)
    ) {
      for (
        const message of
        data.messages
      ) {
        if (
          message?.id &&
          message?.threadId
        ) {
          messages.push({
            id:
              String(message.id),
            threadId:
              String(
                message.threadId,
              ),
          });
        }
      }
    }

    pages++;

    pageToken =
      String(
        data.nextPageToken || "",
      );

    if (!pageToken) break;
  }

  return {
    query,
    pages,
    messages,
  };
}

Deno.serve(
  async req => {

    if (
      req.method === "OPTIONS"
    ) {
      return new Response(
        "ok",
        {
          status: 200,
          headers:
            CORS_HEADERS,
        },
      );
    }

    if (
      req.method !== "POST"
    ) {
      return json(
        {
          ok: false,
          error:
            "POST required",
        },
        405,
      );
    }

    if (
      !(await isAuthorized(req))
    ) {
      return json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        401,
      );
    }

    try {
      const token =
        await getGmailAccessToken();

      const {
        data: contacts,
        error: contactsError,
      } =
        await supabase
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
            gmail_thread_id
          `)
          .not(
            "gmail_thread_id",
            "is",
            null,
          );

      if (contactsError) {
        throw contactsError;
      }

      const contactByThread =
        new Map<
          string,
          any[]
        >();

      for (
        const contact of
        contacts ?? []
      ) {
        const threadId =
          String(
            contact.gmail_thread_id ||
            "",
          );

        if (!threadId) continue;

        const existing =
          contactByThread.get(
            threadId,
          ) || [];

        existing.push(contact);

        contactByThread.set(
          threadId,
          existing,
        );
      }

      const listed =
        await listRecentInboundMessages(
          token,
        );

      const candidates =
        listed.messages.filter(
          message =>
            contactByThread.has(
              message.threadId,
            ),
        );

      let replies = 0;
      let failures = 0;
      let skippedDuplicate = 0;
      let skippedSenderMismatch = 0;

      const errors: any[] = [];

      for (
        const candidate of
        candidates
      ) {
        try {
          const message =
            await gmailGet(
              `messages/${encodeURIComponent(
                candidate.id,
              )}?format=full`,
              token,
            );

          const fromRaw =
            header(
              message.payload?.headers,
              "From",
            );

          const fromEmail =
            emailAddress(
              fromRaw,
            );

          if (
            !fromEmail ||
            fromEmail ===
              GMAIL_ACCOUNT
          ) {
            continue;
          }

          const matchingContacts =
            contactByThread.get(
              candidate.threadId,
            ) || [];

          const contact =
            matchingContacts.find(
              c =>
                String(
                  c.coach_email ||
                  "",
                )
                  .trim()
                  .toLowerCase() ===
                fromEmail,
            ) ||
            matchingContacts[0];

          if (!contact) {
            continue;
          }

          if (
            contact.coach_email &&
            emailAddress(
              contact.coach_email,
            ) !==
              fromEmail
          ) {
            skippedSenderMismatch++;
            continue;
          }

          const messageId =
            String(
              message.id || "",
            );

          if (!messageId) {
            continue;
          }

          const {
            data: existing,
            error:
              existingError,
          } =
            await supabase
              .from(
                "recruiting_contact_history",
              )
              .select("id")
              .eq(
                "owner_user_id",
                contact.owner_user_id,
              )
              .eq(
                "gmail_message_id",
                messageId,
              )
              .maybeSingle();

          if (existingError) {
            throw existingError;
          }

          if (existing) {
            skippedDuplicate++;
            continue;
          }

          const subject =
            header(
              message.payload?.headers,
              "Subject",
            );

          const rawBody =
            collectText(
              message.payload,
            );

          const body =
            cleanReplyText(
              rawBody,
            );

          const interest =
            classifyInterest(
              body,
            );

          const receivedAt =
            new Date(
              Number(
                message.internalDate ??
                Date.now(),
              ),
            ).toISOString();

          const note = [
            `Gmail返信: ${
              subject ||
              "(件名なし)"
            }`,
            `From: ${
              fromRaw ||
              contact.coach_email ||
              contact.coach_name
            }`,
            body.trim()
              ? body
                  .trim()
                  .slice(
                    0,
                    4000,
                  )
              : "(本文を取得できませんでした)",
          ].join("\n");

          const {
            data: updated,
            error:
              updateError,
          } =
            await supabase
              .from(
                "recruiting_contacts",
              )
              .update({
                contact_status:
                  "responded",

                coach_response:
                  body
                    .trim()
                    .slice(
                      0,
                      4000,
                    ) ||
                  subject ||
                  "Gmail返信あり",

                last_contact_at:
                  receivedAt,

                follow_up_date:
                  null,

                auto_follow_up_enabled:
                  false,

                next_action:
                  interest.level ===
                  "high"
                    ? "優先確認：返信内容を確認"
                    : "返信内容を確認",

                interest_level:
                  interest.level,

                interest_reason:
                  interest.reason,

                interest_analyzed_at:
                  receivedAt,
              })
              .eq(
                "id",
                contact.id,
              )
              .eq(
                "owner_user_id",
                contact.owner_user_id,
              )
              .select("id")
              .single();

          if (
            updateError ||
            !updated
          ) {
            throw (
              updateError ??
              new Error(
                "CRM contact update failed.",
              )
            );
          }

          const {
            error:
              historyError,
          } =
            await supabase
              .from(
                "recruiting_contact_history",
              )
              .insert({
                owner_user_id:
                  contact.owner_user_id,

                contact_id:
                  contact.id,

                event_type:
                  "reply_received",

                event_at:
                  receivedAt,

                note,

                to_status:
                  "responded",

                gmail_message_id:
                  messageId,

                gmail_message_at:
                  receivedAt,
              });

          if (historyError) {
            throw historyError;
          }

          // Gmail label sync.
          // A label failure must not invalidate a successfully
          // detected and stored Coach reply.
          if (candidate.threadId) {
            try {
              await syncRecruitingThreadLabels(
                candidate.threadId,
                "Recruiting/Needs Reply",
              );
            } catch (labelError) {
              console.warn(
                "Reply Gmail label sync failed:",
                labelError,
              );
            }
          }

          if (
            interest.level ===
            "high"
          ) {
            const {
              data:
                dashboard,
            } =
              await supabase
                .from(
                  "recruiting_records",
                )
                .select(
                  "content",
                )
                .eq(
                  "id",
                  "akihiro_dashboard",
                )
                .eq(
                  "owner_user_id",
                  contact.owner_user_id,
                )
                .maybeSingle();

            const current =
              dashboard?.content ||
              {};

            const currentStatus =
              current.statuses?.[
                contact
                  .university_id
              ] ||
              "未接触";

            if (
              [
                "未接触",
                "メール送信済",
                "返信・関心あり",
              ].includes(
                currentStatus,
              ) ||
              !currentStatus
            ) {
              const statuses =
                {
                  ...(
                    current.statuses ||
                    {}
                  ),
                  [contact
                    .university_id]:
                    "返信・関心あり",
                };

              await supabase
                .from(
                  "recruiting_records",
                )
                .upsert(
                  {
                    id:
                      "akihiro_dashboard",

                    owner_user_id:
                      contact
                        .owner_user_id,

                    content: {
                      ...current,
                      statuses,
                    },

                    updated_at:
                      new Date()
                        .toISOString(),
                  },
                  {
                    onConflict:
                      "id",
                  },
                );
            }
          }

          replies++;

        } catch (
          candidateError
        ) {
          failures++;

          const errorMessage =
            candidateError
              instanceof Error
              ? candidateError
                  .message
              : String(
                  candidateError,
                );

          console.error(
            "Reply detection candidate failed:",
            candidate.id,
            candidate.threadId,
            errorMessage,
          );

          errors.push({
            gmail_message_id:
              candidate.id,

            gmail_thread_id:
              candidate.threadId,

            error:
              errorMessage,
          });
        }
      }

      return json({
        ok: true,

        gmail_query:
          listed.query,

        gmail_pages:
          listed.pages,

        tracked_threads:
          contactByThread.size,

        recent_inbound_messages:
          listed.messages.length,

        matched_candidates:
          candidates.length,

        replies,

        failures,

        skipped_duplicate:
          skippedDuplicate,

        skipped_sender_mismatch:
          skippedSenderMismatch,

        errors,
      });

    } catch (error) {
      console.error(
        "Reply detection failed:",
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
);
