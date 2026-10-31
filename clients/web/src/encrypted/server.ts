import { locateInRepository, readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { isProviderError } from "../providers/errors";
import { type Deps, MAX_CIPHERTEXT_BYTES } from "./http";

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
