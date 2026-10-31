/**
 * Whether one quote can be the same words as another after an edit (ROADMAP 1d.2). When the text a thread is about is edited, the browser finds
 * it again and asks for the thread's anchor to be moved onto the new words; the server cannot see the rendered text to check that, so it checks
 * what it can: that the new quote is *like* the old one, which keeps a request from moving a thread onto unrelated text in one step.
 */
export const MAX_CHANGE = 0.4;

/** The number of insertions, deletions and changed characters that turn `a` into `b`, or more than `limit` if it is more (it stops there). */
export function editDistance(a: string, b: string, limit: number): number {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    let least = i;
    for (let j = 1; j <= y.length; j++) {
      const value = Math.min(row[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1), row[j]! + 1, next[j - 1]! + 1);
      next.push(value);
      if (value < least) least = value;
    }
    if (least > limit) return limit + 1;
    row = next;
  }
  return row[y.length]!;
}

/** Whether `to` differs from `from` by no more than `MAX_CHANGE` of the longer one's characters. */
export function isLike(from: string, to: string): boolean {
  const limit = Math.ceil(Math.max([...from].length, [...to].length) * MAX_CHANGE);
  return editDistance(from, to, limit) <= limit;
}
