/** A link inside a repository: `/repo/<public id>/<vault>/<folders…>/<file>`, each segment encoded. */
export function repositoryHref(connection: string, ...segments: string[]): string {
  const path = segments.filter((segment) => segment !== "").flatMap((segment) => segment.split("/")).map(encodeURIComponent);
  return `/repo/${connection}${path.length > 0 ? `/${path.join("/")}` : ""}`;
}

/** The segments of the path part of a `/repo/<connection>/…` URL, decoded; undefined for one that is not valid encoding. */
export function decodeSegments(raw: string[] | undefined): string[] | undefined {
  try {
    return (raw ?? []).map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}
