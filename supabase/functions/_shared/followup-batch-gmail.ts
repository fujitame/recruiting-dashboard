export const GMAIL_ACCOUNT = (Deno.env.get("GMAIL_ACCOUNT") || "fujiakihiro8@gmail.com").toLowerCase();

export function getHeader(headers: any[] = [], name: string): string {
  return String(headers.find((h) => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "");
}

export function emailAddress(value: string): string {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match?.[1] || value || "").trim().toLowerCase();
}

export async function googleAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google OAuth is not configured.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google OAuth refresh failed");
  }
  return data.access_token as string;
}

export async function gmailGetThread(threadId: string, token: string): Promise<any> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(threadId) + "?format=full",
    { headers: { Authorization: "Bearer " + token } },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Gmail thread lookup failed");
  return data;
}

export async function gmailSend(raw: string, threadId: string, token: string): Promise<any> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ raw, threadId }),
  });
  const data = await response.json();
  if (!response.ok || !data.id) {
    throw new Error(data.error?.message || "Gmail did not confirm the message");
  }
  return data;
}

export function threadReplyFrom(thread: any, _coachEmail: string): any | null {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const lastOutbound = [...messages].reverse().find((message) =>
    emailAddress(getHeader(message.payload?.headers || [], "From")) === GMAIL_ACCOUNT
  );
  if (!lastOutbound) return null;
  const lastSentAt = Number(lastOutbound.internalDate || 0);
  // Any post-send external reply suppresses a scheduled follow-up, including replies from
  // another staff member or a shared recruiting inbox.
  return messages.find((message) => {
    const from = emailAddress(getHeader(message.payload?.headers || [], "From"));
    return from && from !== GMAIL_ACCOUNT && Number(message.internalDate || 0) > lastSentAt;
  }) || null;
}
export function latestOutbound(thread: any): any | null {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return [...messages].reverse().find((message) =>
    emailAddress(getHeader(message.payload?.headers || [], "From")) === GMAIL_ACCOUNT
  ) || null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

function extractPlainText(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const found = extractPlainText(child);
      if (found) return found;
    }
  }
  return "";
}

export function plainTextMessage(message: any): string {
  return extractPlainText(message?.payload).trim();
}

export function buildReplyRaw(args: {
  to: string;
  subject: string;
  body: string;
  messageId: string;
  references: string;
}): string {
  const bytes = new TextEncoder().encode(args.body);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const encodedBody = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const encodedSubject = "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(args.subject))) + "?=";
  const clean = (value: string) => value.replace(/[\r\n]/g, " ").trim();
  const references = [args.references, args.messageId].filter(Boolean).join(" ").trim();
  const mime = [
    "To: " + clean(args.to),
    "From: " + GMAIL_ACCOUNT,
    "Subject: " + encodedSubject,
    args.messageId ? "In-Reply-To: " + clean(args.messageId) : "",
    references ? "References: " + clean(references) : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].filter(Boolean).join("\r\n");
  return btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
