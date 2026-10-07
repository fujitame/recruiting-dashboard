import tzLookup from "npm:@photostructure/tz-lookup@11.6.1";
import { DateTime } from "npm:luxon@3.7.2";

export function timezoneForCoordinates(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("School coordinates are missing; this school cannot be scheduled.");
  }
  return tzLookup(latitude, longitude);
}

export function localScheduleToUtc(localDate: string, localTime: string, zone: string): string {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!dateMatch || !timeMatch) throw new Error("Choose a valid local date and time.");

  const [, year, month, day] = dateMatch.map(Number);
  const [, hour, minute] = timeMatch.map(Number);
  const local = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone },
  );

  if (!local.isValid || local.year !== year || local.month !== month ||
      local.day !== day || local.hour !== hour || local.minute !== minute) {
    throw new Error("That local time does not exist because of a daylight-saving time change.");
  }
  if (local.getPossibleOffsets().length !== 1) {
    throw new Error("That local time occurs twice because of a daylight-saving time change. Choose another time.");
  }
  if (local.toUTC() <= DateTime.utc().plus({ minutes: 2 })) {
    throw new Error("Choose a send time at least 2 minutes in the future in every selected school’s time zone.");
  }

  return local.toUTC().toISO({ suppressMilliseconds: false })!;
}

export function localDateAfterSend(isoTimestamp: string, zone: string, days: number): string {
  const sent = DateTime.fromISO(isoTimestamp, { zone: "utc" }).setZone(zone);
  if (!sent.isValid) throw new Error("Could not determine the school-local send date.");
  return sent.plus({ days }).toISODate()!;
}

export function localDateAt(isoTimestamp: string, zone: string): string {
  const local = DateTime.fromISO(isoTimestamp, { zone: "utc" }).setZone(zone);
  if (!local.isValid) throw new Error("Could not determine the school-local date.");
  return local.toISODate()!;
}
