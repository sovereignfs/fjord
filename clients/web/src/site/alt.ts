/**
 * Whether a chosen picture may be put into a post (RFC 0004): it needs words for people who cannot see it, or to be said, on purpose, to be there for
 * looks. Nothing is put in until one is true, so no picture is added without its alt text by forgetting it.
 */
export function canInsert(chosen: boolean, alt: string, decorative: boolean): boolean {
  return chosen && (decorative || alt.trim() !== '');
}
