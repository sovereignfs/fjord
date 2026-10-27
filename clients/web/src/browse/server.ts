import { ConnectionError, type ConnectionErrorCode } from "../connections/errors";
import { connectionService } from "../connections/server";
import type { ConnectionInfo } from "../connections/service";
import { getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import type { ClassifiedFile } from "../format/types";
import { DocIndex } from "./doc-index";
import { type Resolution, type Source, recordRead, resolveDocId } from "./ids";
import { type Problem, describeProblem } from "./problems";
import { type Location, locate } from "./location";
import { type RepositoryRead, readRepository } from "./repository";
import { type NoteText, readNoteText } from "./note";
import { type Assessment, applySetup, assessSetup, isNotFjord } from "./setup";
import { TreeCache } from "./tree-cache";

/**
 * A connected repository's vaults, for a page: the connection's own token, the tree cache, the format module.
 * What the host or the setup can get wrong comes back as a `Problem` to show; anything else is thrown.
 */
export type Outcome = { ok: true; read: RepositoryRead } | { ok: false; problem: Problem };

export async function readConnection(accountId: string, connection: ConnectionInfo): Promise<Outcome> {
  try {
    const used = await (await connectionService()).provider(accountId, connection.id);
    if (!used) return { ok: false, problem: { code: "not_found", message: "That repository is not connected." } };
    const read = await readRepository(
      { provider: used.provider, cache: new TreeCache(await getDatabase()), format: fjord() },
      { id: connection.id, ref: { owner: connection.owner, name: connection.name }, branch: connection.branch },
    );
    return { ok: true, read };
  } catch (error) {
    const problem = describeProblem(error);
    // A setup problem is the operator's to fix, and the page says only that: the detail goes to the log.
    if (problem?.code === "setup") console.error(`[fjord] ${error instanceof Error ? error.message : "the format module is not available"}`);
    if (problem) return { ok: false, problem };
    throw error;
  }
}

/** Where a path inside a read repository leads, with what the host can get wrong said and not thrown. */
export async function locateInRepository(accountId: string, connection: ConnectionInfo, read: RepositoryRead, segments: string[]): Promise<{ ok: true; location: Location } | { ok: false; problem: Problem }> {
  try {
    const used = await (await connectionService()).provider(accountId, connection.id);
    if (!used) return { ok: false, problem: { code: "not_found", message: "That repository is not connected." } };
    return { ok: true, location: await locate({ provider: used.provider, format: fjord() }, read, { owner: connection.owner, name: connection.name }, segments) };
  } catch (error) {
    const problem = describeProblem(error);
    if (problem) return { ok: false, problem };
    throw error;
  }
}

/**
 * What to offer a repository that is not a Fjord repository (ROADMAP 1a.10), or nothing for one that is, or that could
 * not be read. Reads the root of the repository and tries a write that changes nothing; writes nothing.
 */
export async function assessSetupFor(accountId: string, connection: ConnectionInfo, outcome: Outcome): Promise<Assessment | undefined> {
  if (!outcome.ok || !isNotFjord(outcome.read)) return undefined;
  try {
    const used = await (await connectionService()).provider(accountId, connection.id);
    if (!used) return undefined;
    return await assessSetup(
      { provider: used.provider, cache: new TreeCache(await getDatabase()), format: fjord() },
      { id: connection.id, ref: { owner: connection.owner, name: connection.name }, branch: connection.branch, repositoryName: connection.name },
      outcome.read,
    );
  } catch (error) {
    const problem = describeProblem(error);
    if (problem) return { offer: false, refusal: { code: "unavailable", message: problem.message } };
    throw error;
  }
}

/** How a problem with the host or the setup is told to the person who asked for the setup. */
const PROBLEM_CODES: Record<Problem["code"], ConnectionErrorCode> = {
  unauthorized: "bad_token",
  not_found: "not_found",
  forbidden: "forbidden",
  empty_repository: "empty_repository",
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  credential: "bad_token",
  setup: "unavailable",
};

/**
 * Set one of the account's repositories up as a Fjord repository with a vault of this name: one commit. `found: false`
 * if it is not theirs. Everything that can go wrong comes back as a `ConnectionError` with words for the person.
 */
export async function setUpRepository(accountId: string, id: number, vault: string): Promise<{ found: false } | { found: true; commit: string }> {
  const connection = await (await connectionService()).get(accountId, id);
  if (!connection) return { found: false };
  try {
    const used = await (await connectionService()).provider(accountId, id);
    if (!used) return { found: false };
    const done = await applySetup(
      { provider: used.provider, cache: new TreeCache(await getDatabase()), format: fjord() },
      { id, ref: { owner: connection.owner, name: connection.name }, branch: connection.branch, repositoryName: connection.name },
      vault,
    );
    return { found: true, commit: done.commit };
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    const problem = describeProblem(error);
    if (problem?.code === "setup") console.error(`[fjord] ${error instanceof Error ? error.message : "the format module is not available"}`);
    if (problem) throw new ConnectionError(PROBLEM_CODES[problem.code], problem.message);
    throw error;
  }
}

/** A note's text for the page, or why there is none: what the host or the setup got wrong is said, not thrown. */
export async function readNoteFor(accountId: string, connection: ConnectionInfo, read: RepositoryRead, path: string): Promise<NoteText | { ok: false; reason: "problem"; message: string }> {
  try {
    const used = await (await connectionService()).provider(accountId, connection.id);
    if (!used) return { ok: false, reason: "problem", message: "That repository is not connected." };
    return await readNoteText(used.provider, { owner: connection.owner, name: connection.name }, read, path);
  } catch (error) {
    const problem = describeProblem(error);
    if (problem) return { ok: false, reason: "problem", message: problem.message };
    throw error;
  }
}

/**
 * Note what a page just read of a file, so that its `id` can be found later (ROADMAP 1b.6). The page does not depend on it:
 * if the index cannot be written the file is shown all the same, and the failure is logged by name only.
 */
export async function recordFileRead(connectionId: number, file: ClassifiedFile, blob: string, text: string): Promise<void> {
  try {
    await recordRead(new DocIndex(await getDatabase()), fjord(), connectionId, file, blob, text);
  } catch (error) {
    console.error(`[fjord] id index: could not record a file (${error instanceof Error ? error.name : "failure"})`);
  }
}

/**
 * Where a Doc `id` is, among the account's own repositories (ROADMAP 1b.6). A repository that cannot be read just now is left
 * out of the search, and the answer says so: a missing file is not reported as absent when a repository could not be asked.
 */
export async function findDocId(accountId: string, docId: string): Promise<Resolution & { unreachable: boolean }> {
  const service = await connectionService();
  const sources: Source[] = [];
  let unreachable = false;
  for (const connection of await service.list(accountId)) {
    const outcome = await readConnection(accountId, connection);
    const used = outcome.ok ? await service.provider(accountId, connection.id) : undefined;
    if (!outcome.ok || !used) {
      unreachable = true;
      continue;
    }
    sources.push({ connectionId: connection.id, ref: { owner: connection.owner, name: connection.name }, read: outcome.read, provider: used.provider });
  }
  const resolution = await resolveDocId({ index: new DocIndex(await getDatabase()), format: fjord() }, sources, docId);
  return { ...resolution, unreachable };
}
