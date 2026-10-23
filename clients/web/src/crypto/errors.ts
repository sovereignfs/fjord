/**
 * Why a credential could not be sealed or opened. The message never carries the credential, a
 * key or any part of one: it may name a key's fingerprint (`kek_id`), which is not a secret.
 *
 *   no_key       no instance key is configured, and one is needed
 *   unknown_key  the credential was sealed under a key that is not configured
 *   corrupt      what is stored is not what was sealed: altered, truncated, or moved to another row
 *   not_found    there is no credential with that id
 */
export type CredentialErrorCode = "no_key" | "unknown_key" | "corrupt" | "not_found";

export class CredentialError extends Error {
  override name = "CredentialError";
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isCredentialError(error: unknown, code?: CredentialErrorCode): error is CredentialError {
  return error instanceof CredentialError && (code === undefined || error.code === code);
}
