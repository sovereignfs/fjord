/**
 * How long after it a deleted file is offered for putting back (DESIGN.md §8, §19 #11): `FJORD_RESTORE_WINDOW_DAYS`, default
 * 30. Git has the file in its history for ever; this is how long the app lists it under Recently deleted and offers Undo.
 * A value that is not a whole number of days from 1 to 3650 is not used, and the default is.
 */
export const DEFAULT_RESTORE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function restoreWindowMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.FJORD_RESTORE_WINDOW_DAYS ?? "").trim();
  const days = /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : DEFAULT_RESTORE_WINDOW_DAYS;
  return (days <= 3650 ? days : DEFAULT_RESTORE_WINDOW_DAYS) * DAY_MS;
}
