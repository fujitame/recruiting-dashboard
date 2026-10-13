import { emailAddress, GMAIL_ACCOUNT, getHeader, outboundIncludesRecipient, plainTextMessage } from "./followup-batch-gmail.ts";

export class ConversationBlocked extends Error {}

// Read Gmail again for drafting AND sending. CRM history alone can be stale when
// the user replies directly in Gmail, or when another staff member joins a thread.
export async function conversationSnapshot(thread: any, recipient: string, forceDue = false) {
  const messages = (Array.isArray(thread?.messages) ? thread.messages : [])
    .filter((m: any) => !(m.labelIds || []).includes("DRAFT"))
    .sort((a: any, b: any) => Number(a.internalDate) - Number(b.internalDate));
  if (!messages.length || messages.some((m: any) => !m.id || !Number(m.internalDate))) {
    throw new ConversationBlocked("Gmailの会話履歴を確認できません。再読み込みしてください。");
  }
  const from = (m: any) => emailAddress(getHeader(m.payload?.headers, "From"));
  const latest = messages[messages.length - 1];
  if (from(latest) !== GMAIL_ACCOUNT) {
    throw new ConversationBlocked("新しい返信が届いています。AI返信案から対応してください。");
  }
  if (!outboundIncludesRecipient(latest, recipient)) {
    throw new ConversationBlocked("最後の送信先がこのCoachと一致しません。Gmailの会話を確認してください。");
  }
  if (!messages.some((m: any) => from(m) === recipient.trim().toLowerCase())) {
    throw new ConversationBlocked("このCoachからの返信をGmailで確認できません。");
  }
  const dueAt = Number(latest.internalDate) + 7 * 24 * 60 * 60 * 1000;
  if (!forceDue && Date.now() < dueAt) {
    throw new ConversationBlocked("Gmailでの最後の返信から7日経過していません。");
  }
  const subject = getHeader(latest.payload?.headers, "Subject").trim();
  if (!subject) throw new ConversationBlocked("Gmailの件名を確認できません。");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(messages.map((m: any) => [m.id, m.internalDate])),
  ));
  const snapshot = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
  return { messages, latest, subject, snapshot, due_at: new Date(dueAt).toISOString() };
}

function htmlText(part: any): string {
  if (part?.mimeType === "text/html" && part.body?.data) {
    const data = String(part.body.data).replace(/-/g, "+").replace(/_/g, "/");
    const html = new TextDecoder().decode(Uint8Array.from(atob(data + "=".repeat((4 - data.length % 4) % 4)), c => c.charCodeAt(0)));
    return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      .replace(/<br\s*\/?\s*>|<\/(?:p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, s => ({"&nbsp;":" ","&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'"}[s] || s))
      .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
        const value = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
      }).trim();
  }
  for (const child of part?.parts || []) {
    const found = htmlText(child);
    if (found) return found;
  }
  return "";
}

export function conversationTranscript(messages: any[]) {
  if (messages.length > 50) throw new ConversationBlocked("会話が長いため、自動文案を作成できません。個別に内容を確認してください。");
  const transcript = messages.map((m: any) => {
    const full = plainTextMessage(m) || htmlText(m.payload);
    // Each message is represented separately; omit repeated quoted tails.
    const body = full.split(/\n(?:On [^\n]+wrote:|[^\n]+さんは書きました:|>)/)[0].trim();
    if (!body) throw new ConversationBlocked("Gmail本文を取得できないメールがあります。固定文面では代替せず、文案作成を停止しました。");
    return {
      from: emailAddress(getHeader(m.payload?.headers, "From")),
      sent_at: new Date(Number(m.internalDate)).toISOString(),
      body,
    };
  });
  if (JSON.stringify(transcript).length > 60000) throw new ConversationBlocked("会話の本文が長いため、個別に内容を確認してください。");
  return transcript;
}
