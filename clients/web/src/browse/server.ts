import { connectionService } from "../connections/server";
import type { ConnectionInfo } from "../connections/service";
import { getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import { type Problem, describeProblem } from "./problems";
import { type Location, locate } from "./location";
import { type RepositoryRead, readRepository } from "./repository";
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
