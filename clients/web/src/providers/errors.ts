/**
 * Why a call to a git host failed, in terms the app can act on and no host's own wording.
 * An error never carries a credential: the message is the host's, the code is ours.
 */
export type ProviderErrorCode =
  /** The credential is missing, expired or revoked. Reconnect. */
  | "unauthorized"
  /** The credential is fine but may not do this: a read-only token asked to write. */
  | "forbidden"
  /** The repository, branch, path or object is not there, or the credential cannot see it. */
  | "not_found"
  /** The repository exists and has no commits. */
  | "empty_repository"
  /** The branch is no longer at the commit the caller built on. Read again, and decide. */
  | "head_moved"
  /** A commit that would change nothing. */
  | "no_changes"
  /** Asked for too much: a blob past the limit the caller set, or the host's. */
  | "too_large"
  /** The host is limiting this credential. `resetAt` or `retryAfterSeconds` say when to try again. */
  | "rate_limited"
  /** The host or the network did not answer properly. Worth trying again later. */
  | "unavailable"
  /** The request itself is wrong: an empty commit, a path the host rejects. */
  | "invalid_request"
  /** A webhook whose signature does not match. */
  | "invalid_webhook";

export class ProviderError extends Error {
  override name = "ProviderError";

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details: { status?: number; resetAt?: Date; retryAfterSeconds?: number; requestId?: string } = {},
  ) {
    super(message);
  }
}

export const isProviderError = (error: unknown, code?: ProviderErrorCode): error is ProviderError =>
  error instanceof ProviderError && (code === undefined || error.code === code);
