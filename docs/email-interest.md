# School email engagement
Implemented 2026-10-26. This measures response to sent content, not recruiting interest or coach identity.

CRM: school badge and CRM > 送信メールへの関心度（学校別）. Expand a school for HC/AC recipient details. Shared recipient addresses are grouped and explicitly unidentified. Uses sent tracking rows, current test mode and a rolling 30-day signal window. No follow-up timers, contact status or interest_level are changed.

| Level | Evidence |
|---|---|
| 強い反応 | Resume download click or cumulative 30 seconds of foreground embedded playback |
| 操作あり | Profile trusted interaction and foreground dwell, embedded playback start, or Profile-to-YouTube click |
| リンク反応 | Profile or email-to-YouTube URL retrieval, excluding known scanner UAs |
| 参考情報のみ | Image retrieval only |
| 未検知 | Tracked sent email without recent signals |
| 計測対象なし | No tracked sent messages |

Raw URL retrieval may be a scanner even if its UA is not recognized. Interactions are stronger signals, not proof of a particular person. Forwarded links stay attributed to the original recipient. A download click is not proof the PDF finished downloading; external YouTube links do not reveal playback or watch time.

Profile attribution travels in a URL fragment, removed before the deferred script sends events. No cookies, local storage, IP addresses, user-agent strings or form content are stored for these new signals. Direct visits without an email token are unmeasured. Hidden/unfocused playback, large seeks and webdriver visits are excluded. Browser/YouTube blocking can cause missed signals.

The public endpoint accepts bounded same-origin POST signals keyed by unguessable email tokens. It never permits arbitrary redirects. DB rejects expired/unsent tokens and known automated traffic, deduplicates event/video slot within ten minutes, caps counters, and restricts reads by owner RLS. Existing legacy tracked Profile links can now carry attribution. Already-sent plain untracked URLs cannot be rewritten retrospectively.

Common initial/reply/follow-up send paths add tracked Profile and recognized current player-master YouTube URLs in the transport copy only. Video destinations are snapshotted per tracking row. Gmail body readback verifies that copy; uncertain sends retain existing no-blind-retry behavior. No additional paid analytics provider. Usage counts against existing hosting/Supabase quotas.

Validation: Node syntax/TS parsing; MIME/readback/uncertain-send tests with Gmail mocked; classifier and actual school/role rendering fixtures; endpoint origin/token/redirect tests; Profile foreground, trusted gesture, seek and playback mocks; live SQL transaction tests rolled back for RLS, dedup, invalid/automated/expired/unsent rejection. No test email sent.
