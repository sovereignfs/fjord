/** A link inside a repository: `/repo/<public id>/<vault>/<folders…>/<file>`, each segment encoded. */
export function repositoryHref(connection: string, ...segments: string[]): string {
  const path = segments.filter((segment) => segment !== "").flatMap((segment) => segment.split("/")).map(encodeURIComponent);
  return `/repo/${connection}${path.length > 0 ? `/${path.join("/")}` : ""}`;
}

/** What was deleted from a repository (ROADMAP 1b.12): its own page, in the repository's address. In this file, which is plain strings, because the page's client components draw the link too. */
export const deletedAddress = (repo: string): string => `/repo/${repo}/deleted`;

/** The segments of the path part of a `/repo/<connection>/…` URL, decoded; undefined for one that is not valid encoding. */
export function decodeSegments(raw: string[] | undefined): string[] | undefined {
  try {
    return (raw ?? []).map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}
