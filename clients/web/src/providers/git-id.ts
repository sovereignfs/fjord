import { createHash } from "node:crypto";

/**
 * The id git gives a file's contents: SHA-1 of `blob <length>\0` and the bytes. A host reports
 * blob ids, so a blob that was read can be checked against its id, which is how a test knows
 * the bytes that came back are the bytes that are in the repository.
 */
export function gitBlobId(content: Uint8Array): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}
