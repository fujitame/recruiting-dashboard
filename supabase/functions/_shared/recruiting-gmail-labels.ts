const GOOGLE_CLIENT_ID =
  Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");

const GOOGLE_CLIENT_SECRET =
  Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");

const GOOGLE_REFRESH_TOKEN =
  Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

if (
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REFRESH_TOKEN
) {
  throw new Error(
    "Required Gmail OAuth secrets are not configured.",
  );
}

export const RECRUITING_PARENT_LABEL =
  "Recruiting";

export const RECRUITING_STATE_LABELS = [
  "Recruiting/Waiting Coach",
  "Recruiting/Needs Reply",
  "Recruiting/Follow-up Due",
  "Recruiting/No Response",
  "Recruiting/Closed",
];

export async function googleAccessToken() {
  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/x-www-form-urlencoded",
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

export async function gmailRequest(
  path: string,
  token: string,
  init: RequestInit = {},
) {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/" +
      path,
    {
      ...init,
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json",
        ...(init.headers || {}),
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

export function recruitingEventTime(
  row: any,
): number {
  const value =
    row?.gmail_message_at ||
    row?.event_at ||
    row?.created_at;

  const ms =
    new Date(value || 0).getTime();

  return Number.isFinite(ms)
    ? ms
    : 0;
}

export function chooseRecruitingStateLabel(
  contact: any,
  history: any[],
): string | null {
  const status =
    String(contact?.contact_status || "");

  if (
    status === "closed" ||
    status === "not_a_fit"
  ) {
    return "Recruiting/Closed";
  }

  if (status === "no_response") {
    return "Recruiting/No Response";
  }

  if (status === "follow_up_due") {
    return "Recruiting/Follow-up Due";
  }

  if (status === "contacted") {
    return "Recruiting/Waiting Coach";
  }

  if (status === "responded") {
    const conversationEvents =
      (history || [])
        .filter((row: any) =>
          [
            "reply_received",
            "reply_sent",
            "conversation_follow_up_sent",
          ].includes(
            String(row.event_type || ""),
          ),
        )
        .sort(
          (a: any, b: any) =>
            recruitingEventTime(b) -
            recruitingEventTime(a),
        );

    const latest =
      conversationEvents[0];

    if (
      latest?.event_type ===
      "reply_received"
    ) {
      return "Recruiting/Needs Reply";
    }

    if (
      latest?.event_type ===
        "reply_sent" ||
      latest?.event_type ===
        "conversation_follow_up_sent"
    ) {
      return "Recruiting/Waiting Coach";
    }

    if (
      String(contact?.coach_response || "")
        .trim()
    ) {
      return "Recruiting/Needs Reply";
    }
  }

  return null;
}

export async function syncRecruitingThreadLabels(
  threadId: string,
  targetLabel: string | null,
) {
  if (!threadId) {
    throw new Error(
      "Gmail thread ID is missing",
    );
  }

  const token =
    await googleAccessToken();

  const labelData =
    await gmailRequest(
      "labels",
      token,
    );

  const labels =
    Array.isArray(labelData.labels)
      ? labelData.labels
      : [];

  const byName = new Map(
    labels.map((label: any) => [
      String(label.name),
      String(label.id),
    ]),
  );

  const parentId =
    byName.get(
      RECRUITING_PARENT_LABEL,
    );

  if (!parentId) {
    throw new Error(
      "Recruiting parent label not found",
    );
  }

  const targetId =
    targetLabel
      ? byName.get(targetLabel)
      : null;

  if (
    targetLabel &&
    !targetId
  ) {
    throw new Error(
      `Required state label not found: ${targetLabel}`,
    );
  }

  const removeLabelIds =
    RECRUITING_STATE_LABELS
      .map(name => byName.get(name))
      .filter(Boolean)
      .filter(id => id !== targetId);

  const addLabelIds = [
    parentId,
  ];

  if (targetId) {
    addLabelIds.push(targetId);
  }

  await gmailRequest(
    `threads/${encodeURIComponent(
      threadId,
    )}/modify`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        addLabelIds,
        removeLabelIds,
      }),
    },
  );

  return {
    parent_label:
      RECRUITING_PARENT_LABEL,
    target_label:
      targetLabel,
  };
}
