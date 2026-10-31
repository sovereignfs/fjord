/**
 * What the worker is told by the environment (DESIGN.md §11, §19 #5, ROADMAP 1b.13).
 *
 * - `FJORD_IDLE_VERSION_MINUTES`: how long a draft must go without an edit before the worker makes a version of it. A whole number of
 *   minutes from 1 to 1440, default 5; `0` turns idle versions off (a draft then waits for someone to choose Save version). Anything
 *   else is not used, and the default is.
 * - `FJORD_WORKER`: `off` keeps this process from running the worker. With several web processes on one database, one of them runs it
 *   (a second would only find its work done already, but would ask the git host for nothing).
 */
export const DEFAULT_IDLE_VERSION_MINUTES = 5;
const MINUTE_MS = 60 * 1000;

/** The quiet period in milliseconds, or `undefined` when idle versions are off. */
export function idleVersionMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = (env.FJORD_IDLE_VERSION_MINUTES ?? "").trim();
  if (raw === "0") return undefined;
  const minutes = /^[1-9][0-9]{0,3}$/.test(raw) && Number(raw) <= 1440 ? Number(raw) : DEFAULT_IDLE_VERSION_MINUTES;
  return minutes * MINUTE_MS;
}

export function workerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FJORD_WORKER ?? "").trim().toLowerCase() !== "off";
}
