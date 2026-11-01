import type { RepositoryRead } from "../browse/repository";
import { locateInRepository, readConnection } from "../browse/server";
import type { ConnectionInfo } from "../connections/service";
import { connectionService } from "../connections/server";
import { isProviderError } from "../providers/errors";
import { workingCopyService } from "../working/server";
import { checkEncryptedVault } from "../files/create-encrypted";
import { type Deps, MAX_CIPHERTEXT_BYTES, type RecipientsDeps } from "./http";
import { type Recipients, readRecipients } from "./recipients";

/**
 * The server's side of `/api/connections/<id>/ciphertext`: the connection must be the caller's, and the path must lead, in the repository as it is now, to an
 * encrypted payload in an encrypted vault. The bytes are read by blob, with the connection's own token, and handed on unread.
 */
export const readCiphertext: Deps["read"] = async (accountId, id, path) => {
  const service = await connectionService();
  const connection = await service.get(accountId, id);
  if (!connection) return { found: false };

  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return { found: true, result: { ok: false, reason: outcome.problem.code === "not_found" ? "not_encrypted" : "unavailable" } };
  const found = await locateInRepository(accountId, connection, outcome.read, path.split("/"));
  if (!found.ok) return { found: true, result: { ok: false, reason: "unavailable" } };
  const { location } = found;
  if (location.kind !== "file" || location.file.kind !== "payload" || location.vault.encrypted !== true) return { found: true, result: { ok: false, reason: "not_encrypted" } };

  const blob = outcome.read.blobs.get(location.file.path);
  if (blob === undefined) return { found: true, result: { ok: false, reason: "unavailable" } };
  const used = await service.provider(accountId, id);
  if (!used) return { found: false };
  try {
    return { found: true, result: { ok: true, bytes: await used.provider.readBlob({ owner: connection.owner, name: connection.name }, blob, { maxBytes: MAX_CIPHERTEXT_BYTES }) } };
  } catch (error) {
    if (isProviderError(error, "too_large")) return { found: true, result: { ok: false, reason: "too_large" } };
    if (isProviderError(error, "unauthorized")) return { found: true, result: { ok: false, reason: "bad_token" } };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable")) return { found: true, result: { ok: false, reason: "unavailable" } };
    throw error;
  }
};

/**
 * What the page of an encrypted file needs to edit it (ROADMAP 2b.3): the draft of it, if there is one (ciphertext, as stored), and the vault's recipients, which
 * the browser encrypts to. Neither is secret from the server: it holds the one and reads the other from the repository.
 */
export async function recipientsFor(accountId: string, connection: ConnectionInfo, read: RepositoryRead, vaultDirectory: string): Promise<Recipients> {
  const used = await (await connectionService()).provider(accountId, connection.id);
  return used ? readRecipients(used.provider, { owner: connection.owner, name: connection.name }, read, vaultDirectory) : { ok: false, message: "That repository is not connected." };
}

export async function editingFor(accountId: string, connection: ConnectionInfo, read: RepositoryRead, vaultDirectory: string, path: string) {
  const kept = await (await workingCopyService()).get(connection.id, path);
  const draft = kept?.encrypted ? { content: kept.content, baseBlob: kept.baseBlob } : null;
  const used = await (await connectionService()).provider(accountId, connection.id);
  const recipients: Recipients = used ? await readRecipients(used.provider, { owner: connection.owner, name: connection.name }, read, vaultDirectory) : { ok: false, message: "That repository is not connected." };
  return { draft, recipients };
}

/** The recipients of one of the account's encrypted vaults, for a page that moves a file into it (ROADMAP 2b.6): only a vault this version writes to. */
export const readVaultRecipients: RecipientsDeps["read"] = async (accountId, id, vault) => {
  const connection = await (await connectionService()).get(accountId, id);
  if (!connection) return { found: false };
  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return { found: true, result: { ok: false, reason: outcome.problem.code === "not_found" ? "not_a_vault" : "unavailable" } };
  if (!checkEncryptedVault(outcome.read.discovery.vaults, outcome.read.manifests, vault).ok) return { found: true, result: { ok: false, reason: "not_a_vault" } };
  const recipients = await recipientsFor(accountId, connection, outcome.read, vault);
  return { found: true, result: recipients.ok ? { ok: true, text: recipients.text } : { ok: false, reason: "no_recipients" } };
};
