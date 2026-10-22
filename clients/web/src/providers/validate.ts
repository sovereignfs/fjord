import { ProviderError } from "./errors";
import type { CommitRequest } from "./types";

/**
 * A path a commit may write. A host would take `.git/config`, or `a/../b`, and a repository with a
 * file there is not one to open, so every provider refuses them, whoever asks.
 */
export function assertWritablePath(path: string): void {
  const segments = path.split("/");
  const bad =
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git");
  if (bad) throw new ProviderError("invalid_request", `"${path}" is not a path a commit can write`);
}

/** What every provider checks before it looks at the host: the request itself must make sense. */
export function validateCommitRequest(request: CommitRequest): void {
  if (request.changes.length === 0) throw new ProviderError("invalid_request", "a commit needs at least one change");
  if (request.message.trim() === "") throw new ProviderError("invalid_request", "a commit needs a message");
  const seen = new Set<string>();
  for (const change of request.changes) {
    assertWritablePath(change.path);
    if (seen.has(change.path)) throw new ProviderError("invalid_request", `"${change.path}" is changed twice in one commit`);
    seen.add(change.path);
  }
}
