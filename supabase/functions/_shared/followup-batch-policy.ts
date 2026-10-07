export const TEST_RECIPIENT = "fujitame@gmail.com";
export const TEST_BANNER = "TEST MODE — This message is sent only to fujitame@gmail.com.";
export type BatchMode = "test" | "production";
export function batchMode(testMode: unknown): BatchMode {
  if (typeof testMode !== "boolean") throw new Error("Explicit test_mode boolean required");
  return testMode ? "test" : "production";
}
export function schoolInMode(school: any, mode: BatchMode): boolean {
  const id = Number(school?.id);
  return mode === "test" ? school?.is_test === true && [900,901,902].includes(id)
    : school?.is_test === false && id >= 1 && id <= 900;
}
export function validCoachEmail(value: unknown): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(value || ""));
}
export function followUpEligible(contact: any): boolean {
  return ["head_coach","assistant_coach"].includes(contact?.coach_role) &&
    ["contacted","follow_up_due"].includes(contact?.contact_status) &&
    !String(contact?.coach_response || "").trim() && [0,1].includes(Number(contact?.follow_up_count || 0));
}
export function hasReply(contact: any): boolean {
  return contact?.contact_status === "responded" || !!String(contact?.coach_response || "").trim();
}
