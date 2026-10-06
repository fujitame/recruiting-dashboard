import { withSupabase } from "npm:@supabase/server@1";
import { find } from "npm:geo-tz@8.1.9";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function nextThursdayAtTen(timeZone: string, now: Date) {
  const local = dateParts(now, timeZone);
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  let daysUntil = (4 - weekday + 7) % 7;
  if (daysUntil === 0 && (local.hour >= 10 || (local.hour === 9 && local.minute >= 55))) daysUntil = 7;

  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + daysUntil));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const day = target.getUTCDate();
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 10, 0);

  let candidate = wallClockAsUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const represented = dateParts(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(represented.year, represented.month - 1, represented.day, represented.hour, represented.minute);
    candidate = wallClockAsUtc - (representedAsUtc - candidate);
  }

  const finalParts = dateParts(new Date(candidate), timeZone);
  if (finalParts.year !== year || finalParts.month !== month || finalParts.day !== day || finalParts.hour !== 10 || finalParts.minute !== 0) {
    throw new Error("Could not resolve the school-local schedule time");
  }
  return new Date(candidate).toISOString();
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method === "OPTIONS") return json({ ok: true });
    if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

    try {
      const payload = await req.json();
      const ids = Array.isArray(payload.university_ids)
        ? [...new Set(payload.university_ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0))].slice(0, 120)
        : [];
      if (!ids.length) return json({ ok: false, error: "university_ids is required" }, 400);

      const { data, error } = await ctx.supabase
        .from("recruiting_universities")
        .select("id,latitude,longitude")
        .in("id", ids);
      if (error) throw error;

      const now = new Date();
      const results = (data || []).map((school: any) => {
        const latitude = Number(school.latitude);
        const longitude = Number(school.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return { university_id: school.id, error: "Missing verified coordinates" };
        }
        const zones = find(latitude, longitude);
        if (!Array.isArray(zones) || zones.length !== 1) {
          return { university_id: school.id, error: "Timezone is ambiguous at the stored coordinates" };
        }
        const timezone = zones[0];
        return {
          university_id: school.id,
          timezone,
          scheduled_at: nextThursdayAtTen(timezone, now),
        };
      });

      return json({ ok: true, schools: results });
    } catch (error) {
      console.error("Follow-up batch timezone preview failed:", error);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }),
};
