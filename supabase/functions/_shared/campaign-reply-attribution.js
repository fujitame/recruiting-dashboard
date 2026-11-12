// Resolve only the reply's direct RFC Message-ID parent. Thread/date alone is ambiguous.
export function directOutboundParent(reply, thread, account) {
  const header = (m, name) => String((m?.payload?.headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value || '');
  const ids = header(reply, 'In-Reply-To').match(/<[^<>\s]+>/g) || [];
  if (ids.length !== 1) return null;
  const matches = (thread?.messages || []).filter(m => {
    const from = header(m, 'From').match(/<([^>]+)>/)?.[1] || header(m, 'From');
    return from.trim().toLowerCase() === account.toLowerCase() && header(m, 'Message-ID').trim() === ids[0];
  });
  return matches.length === 1 ? String(matches[0].id) : null;
}

// A delayed inbound message must not overwrite a later outbound reply's Waiting state.
export function liveReplyStateLabel(thread, account) {
  const from = m => {
    const value = String((m?.payload?.headers || []).find(h => String(h.name).toLowerCase() === 'from')?.value || '');
    return (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase();
  };
  const messages = (thread?.messages || []).filter(m => Number.isFinite(Number(m.internalDate)));
  const sentAt = Math.max(0,...messages.filter(m => from(m) === account.toLowerCase()).map(m => Number(m.internalDate)));
  if (!sentAt) return null;
  return messages.some(m => from(m) && from(m) !== account.toLowerCase() && Number(m.internalDate) > sentAt)
    ? 'Recruiting/Needs Reply' : 'Recruiting/Waiting Coach';
}
