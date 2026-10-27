/**
 * A display name as given (DESIGN.md §12, ROADMAP 1c.6): one line, 1 to 40 characters, no control characters or angle brackets, runs of
 * white space made one space. In its own file because the browser uses it as well as the server (`guest.ts` re-exports it), and
 * both must agree on what a name is.
 */
export const MAX_NAME_CHARS = 40;

export function cleanGuestName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.isWellFormed()) return undefined;
  const name = value.replace(/\s+/g, " ").trim();
  if (name === "" || [...name].length > MAX_NAME_CHARS || /[\u0000-\u001f\u007f<>]/.test(name)) return undefined;
  return name;
}
