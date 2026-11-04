/**
 * What a journal's entry with no title is called. It is filed by the minute it was made (`2026-11-05/00-03.md`), and with nothing in its header or its first line the
 * title falls back to the file's name, `00-03`, which is a name for the file and not for a person. A timeline already has the time, so it says nothing more; an entry's own page says when.
 */
export const isFiledName = (title: string): boolean => /^\d\d-\d\d(-\d+)?$/.test(title);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-11-05T00:03:00+01:00` as the writer read it: its own day and time, whatever the reader's. Null for what is not such a moment. */
export function entryHeading(date: string | null | undefined): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(date ?? "");
  const month = parts ? MONTHS[Number(parts[2]) - 1] : undefined;
  if (!parts || month === undefined) return null;
  const day = `${Number(parts[3])} ${month} ${parts[1]}`;
  return parts[4] === undefined ? day : `${day}, ${parts[4]}:${parts[5]}`;
}
