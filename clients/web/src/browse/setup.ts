import { ConnectionError } from "../connections/errors";
import type { SetupResult } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Change, Provider, RepositoryRef } from "../providers/types";
import pkg from "../../package.json";
import { type RepositoryDeps, type RepositoryRead, readRepository } from "./repository";

/**
 * Setting up a repository that is not a Fjord repository (DESIGN.md §7, ROADMAP 1a.10): what to offer, and doing it.
 *
 * What is written is `fjord-core`'s (`scaffold::plan_setup`, through the format module), never ours: a `fjord.json`,
 * one plaintext vault with a starter note, and, only where it is missing, spec §9's merge guard in `.gitattributes`.
 * Every file is new but for that one, which only ever gains a line at its end. It is one commit through the
 * provider, on the head that was read, never forced: if anything landed meanwhile nothing is written.
 *
 * **Nothing here trusts the browser.** The page shows a preview, and the request that follows carries only the
 * vault's name; the plan is made again, on the repository as it is then.
 */
export const DEFAULT_VAULT = "Public";

/** What this client calls itself in `fjord.json`'s `generator`. Spec §3. */
export const GENERATOR = `fjord-web ${pkg.version}`;

/** `.gitattributes` is a few lines; a larger one is not something to append to blind. */
const MAX_GITATTRIBUTES_BYTES = 64 * 1024;

export interface SetupDeps extends RepositoryDeps {
  /** For tests: at least 80 random bytes. */
  random?: () => Uint8Array;
}

export interface SetupTarget {
  id: number;
  ref: RepositoryRef;
  branch: string;
}

/** What the page shows before anything is written. */
export interface SetupPreview {
  /** The vault's directory, which is also its name. */
  vault: string;
  branch: string;
  /** Every file that would be written: a new one, or a line added to the one that is there. */
  files: { path: string; change: "create" | "append" }[];
}

/** Why a repository that could be set up is not offered it, when the person should be told. */
export interface Refusal {
  code: "read_only" | "gitattributes_unreadable" | "unavailable";
  message: string;
}

export type Assessment = { offer: true; preview: SetupPreview } | { offer: false; refusal: Refusal };

/** Whether this is a repository to offer the setup to: no `fjord.json` and no vault at the root (a broken `fjord.json` is not ours to overwrite). */
export const isNotFjord = (read: RepositoryRead): boolean => read.manifest === null && read.discovery.vaults.length === 0;

const MESSAGES: Record<string, string> = {
  already_fjord: "This repository already has a fjord.json, so there is nothing to set up.",
  has_vaults: "This repository already has vaults, so it is not one to set up.",
  read_only:
    "That token can read this repository but not write to it, so Fjord cannot set it up. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.",
  head_moved: "The repository changed while you were looking at it. Nothing was written. Look again, then set it up.",
  gitattributes_unreadable:
    "This repository's .gitattributes cannot be read (it is too large, or is not text), so Fjord cannot add the one line it needs to it. Nothing was written.",
};

const refused = (code: "already_fjord" | "has_vaults" | "read_only" | "head_moved" | "gitattributes_unreadable") => new ConnectionError(code, MESSAGES[code] as string);

/** What the setup needs to know about the root of the repository, from the host. */
async function gather(deps: SetupDeps, target: SetupTarget, commit: string): Promise<{ paths: string[]; gitattributes: string | null }> {
  const root = await deps.provider.listDirectory(target.ref, commit, "");
  const paths = root.map((entry) => entry.path);
  const entry = root.find((candidate) => candidate.path === ".gitattributes");
  if (!entry) return { paths, gitattributes: null };
  if (entry.kind !== "file") throw refused("gitattributes_unreadable");
  return { paths, gitattributes: await strictText(deps.provider, target.ref, entry.id) };
}

/**
 * `.gitattributes`'s text, exactly: a file that is not valid UTF-8, or is large, is refused, because the text is
 * written back whole with a line added, and a lossy reading would change bytes it was only meant to leave alone. A
 * byte order mark is kept.
 */
export async function strictText(provider: Provider, ref: RepositoryRef, blob: string): Promise<string> {
  try {
    const bytes = await provider.readBlob(ref, blob, { maxBytes: MAX_GITATTRIBUTES_BYTES });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (isProviderError(error, "too_large") || error instanceof TypeError) throw refused("gitattributes_unreadable");
    throw error;
  }
}

function plan(deps: SetupDeps, repositoryName: string, vault: string, gathered: { paths: string[]; gitattributes: string | null }): Extract<SetupResult, { ok: true }> {
  const random = deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(80));
  const made = deps.format.planSetup({ repositoryName, vault, generator: GENERATOR }, gathered, deps.now?.() ?? Date.now(), random);
  if (made.ok) return made;
  switch (made.error.code) {
    case "already_fjord":
      throw refused("already_fjord");
    case "gitattributes_not_read":
      throw refused("gitattributes_unreadable");
    case "invalid_vault_name":
      throw new ConnectionError("invalid_vault_name", made.error.message);
    case "vault_name_taken":
      throw new ConnectionError("vault_name_taken", `${made.error.message}. Choose another name.`);
  }
}

/**
 * What would be written to a repository that is not a Fjord repository, for the page to show. `read` is the
 * repository as `readRepository` saw it. A vault name is chosen (`Public`, else the next free one) unless the
 * person typed one. Nothing is written.
 */
export async function assessSetup(deps: SetupDeps, target: SetupTarget & { repositoryName: string }, read: RepositoryRead, wanted?: string): Promise<Assessment> {
  try {
    if (!(await deps.provider.canWrite(target.ref, target.branch))) return { offer: false, refusal: { code: "read_only", message: MESSAGES.read_only as string } };
    const gathered = await gather(deps, target, read.commit);
    const vault = wanted ?? deps.format.freeVaultName(DEFAULT_VAULT, gathered.paths);
    const made = plan(deps, target.repositoryName, vault, gathered);
    return { offer: true, preview: { vault, branch: read.branch, files: made.files.map((file) => ({ path: file.path, change: file.change })) } };
  } catch (error) {
    if (error instanceof ConnectionError && error.code === "gitattributes_unreadable") return { offer: false, refusal: { code: "gitattributes_unreadable", message: error.message } };
    throw error;
  }
}

/**
 * Set the repository up, with the vault named `vault`: one commit on the head as it is now. Throws a
 * `ConnectionError` saying what is wrong when it is not possible, and when the head moved since it was read.
 */
export async function applySetup(deps: SetupDeps, target: SetupTarget & { repositoryName: string }, vault: string): Promise<{ commit: string }> {
  const read = await readRepository(deps, target);
  if (read.manifest !== null) throw refused("already_fjord");
  if (read.discovery.vaults.length > 0) throw refused("has_vaults");
  if (!(await deps.provider.canWrite(target.ref, target.branch))) throw refused("read_only");

  const gathered = await gather(deps, target, read.commit);
  const made = plan(deps, target.repositoryName, vault, gathered);

  const encoder = new TextEncoder();
  const changes: Change[] = made.files.map((file) => ({ path: file.path, content: encoder.encode(file.contents) }));
  const appended = made.files.some((file) => file.change === "append");
  const message = [
    `Set up Fjord: add the vault "${vault}"`,
    "",
    `Adds fjord.json and the vault "${vault}" (its manifest and a starter note), so that this repository is a Fjord repository.${
      appended ? " Adds one line to .gitattributes, which spec §9 requires." : ""
    } Nothing else that is here is changed.`,
  ].join("\n");

  try {
    const result = await deps.provider.commit(target.ref, { branch: target.branch, expectedHead: read.commit, message, changes });
    return { commit: result.commit };
  } catch (error) {
    if (isProviderError(error, "head_moved")) throw refused("head_moved");
    if (isProviderError(error, "forbidden")) throw refused("read_only");
    throw error;
  }
}
