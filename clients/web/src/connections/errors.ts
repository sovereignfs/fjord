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
 *   already_fjord        setting up a repository that has a fjord.json
 *   has_vaults           setting up a repository that already has vaults
 *   head_moved           the repository changed while it was being set up; nothing was written
 *   gitattributes_unreadable  its .gitattributes is not text, or too large to add a line to
 *   invalid_vault_name   the name cannot be a directory a vault lives in
 *   vault_name_taken     something at the root already has that name, case aside
 *   manifest_unusable    fjord.json is not there or cannot be read, so it is not ours to rewrite
 *   newer_version        the repository declares a newer format than this client implements: read only
 *   invalid_vault_options  the choices for a new vault do not go together (a key on a plaintext vault, a key that is not one)
 *   file_taken           a file a site's engine needs is already in the repository, and is not Fjord's to write over
 *   limit_reached        an account has as much on this server as it may (`src/local/limits.ts`)
 *   invalid_name         the name given to a repository on this server cannot be used
 *   would_overwrite      syncing would change a file the git repository already has; nothing was written
 *   not_local            syncing something that is not on this server
 *   not_verified         the git repository did not hold the files after they were written, so nothing was deleted
 *   kind_rule            the repository does not keep the rules of the kind it would be changed to (spec §3.1)
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
  | "unknown_vault"
  | "already_fjord"
  | "has_vaults"
  | "head_moved"
  | "gitattributes_unreadable"
  | "invalid_vault_name"
  | "vault_name_taken"
  | "manifest_unusable"
  | "newer_version"
  | "invalid_vault_options"
  | "file_taken"
  | "kind_rule"
  | "limit_reached"
  | "invalid_name"
  | "would_overwrite"
  | "not_local"
  | "not_verified";

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
