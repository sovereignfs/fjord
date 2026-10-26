/**
 * Why a repository could not be connected or used, in words a person can act on. The message is
 * shown as it is, so it never carries a token, a key or anything from the host's own error text.
 *
 *   invalid_repository   not a repository address we can read
 *   unsupported_host     an address on a host other than GitHub
 *   invalid_token        empty, or not something that can be a token
 *   bad_token            the host did not accept it: wrong, expired, revoked
 *   not_found            the host cannot see that repository with this token
 *   forbidden            the host refused it, e.g. an organisation that has to approve the token
 *   read_only            the token can read the repository but not write to it
 *   empty_repository     there is nothing in it yet to work on
 *   already_connected    this account has connected it before
 *   rate_limited         the host is limiting requests; try later
 *   unavailable          the host could not be reached
 *   not_configured       this instance has no FJORD_ENCRYPTION_KEY, so it cannot hold a token
 *   unknown_vault        the vault chosen as a default is not in the repository
 */
export type ConnectionErrorCode =
  | "invalid_repository"
  | "unsupported_host"
  | "invalid_token"
  | "bad_token"
  | "not_found"
  | "forbidden"
  | "read_only"
  | "empty_repository"
  | "already_connected"
  | "rate_limited"
  | "unavailable"
  | "not_configured"
  | "unknown_vault";

export class ConnectionError extends Error {
  override name = "ConnectionError";
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const isConnectionError = (error: unknown, code?: ConnectionErrorCode): error is ConnectionError =>
  error instanceof ConnectionError && (code === undefined || error.code === code);
