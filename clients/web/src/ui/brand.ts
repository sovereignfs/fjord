/** The first two letters of the instance's name, the first a capital: "Fjord" is "Fj". It is the mark where there is no logo. */
export function markOf(name: string): string {
  const [first = "F", second = ""] = [...name.trim()];
  return `${first.toUpperCase()}${second}`;
}

/** Initials for a person or a repository: the first letters of its first two words (or, of one word, its first two letters), in capitals. */
export function monogram(name: string): string {
  const [first = "", second = ""] = name.trim().split(/[\s/_-]+/);
  const letters = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2);
  return letters.toUpperCase();
}
