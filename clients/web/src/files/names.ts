/**
 * What is wrong with what a person typed as a file's or a folder's new name, in words for them, or null. A move's destination is a path, so without this
 * a slash in a name is taken as a place, and the file goes into a folder made for it. The rest of the rules are the format's, which the server holds (`move.ts`);
 * these are the ones it cannot tell from a move, or that a form says of a name and a suffix would hide: `trail.` is `trail..md`, which is a legal path.
 */
export function renameProblem(name: string): string | null {
  const typed = name.trim();
  if (typed.includes('/') || typed.includes('\\'))
    return 'A name cannot hold a slash. To put it in another folder, use Move.';
  if (typed.startsWith('.'))
    return 'A name cannot start with a dot: other tools would leave it out of what they list.';
  if (typed.endsWith('.')) return 'A name cannot end with a dot.';
  return null;
}
