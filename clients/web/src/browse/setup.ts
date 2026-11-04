import { ConnectionError } from "../connections/errors";
import type { KindSetupResult, RepositoryKind, SetupResult, SiteEngine } from "../format/types";
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

/**
 * What the repository is set up as (spec §3.1, ROADMAP 3a.3): a drive with one plaintext vault (1a.10's offer), a journal, plaintext or
 * encrypted to the person's keys, or a site for an engine. A site's vault is never encrypted, so there is no choice to make for it.
 */
export type SetupChoice =
  | { kind: "drive"; vault: string }
  | { kind: "journal"; vault: string; encrypted: boolean; recipients: string[] }
  /** `adopt` is the folder of an existing site that its engine reads its content from, made the vault (RFC 0002): nothing of the site is changed. */
  | { kind: "ssg"; engine: SiteEngine; adopt?: string };

/** The directory a journal's vault is offered as, as `fjord init --kind journal` makes it. */
export const DEFAULT_JOURNAL_VAULT = "journal";

/** What one choice would write, or why it cannot be made here (a site's file that is already there). */
export type ChoicePreview = { files: { path: string; change: "create" | "append" }[] } | { refused: string };

/** What the page shows before anything is written. */
export interface SetupPreview {
  /** The vault's directory, which is also its name. */
  vault: string;
  branch: string;
  /** Every file that would be written: a new one, or a line added to the one that is there. */
  files: { path: string; change: "create" | "append" }[];
  /**
   * What each other kind would write (ROADMAP 3a.3): a plaintext journal (in `journalVault`), an encrypted one (shown without keys,
   * which the browser adds), and a site for each engine.
   */
  kinds: { journal: ChoicePreview; encryptedJournal: ChoicePreview; astro: ChoicePreview; jekyll: ChoicePreview };
  /** A static site that is already here, found by its engine's files at the root, and what making its content folder the vault would write; null if there is none. */
  adoptSite: { engine: SiteEngine; content: string; preview: ChoicePreview } | null;
  journalVault: string;
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

function plan(deps: Pick<SetupDeps, "format" | "random" | "now">, repositoryName: string, choice: SetupChoice, gathered: { paths: string[]; gitattributes: string | null }): Extract<SetupResult, { ok: true }> {
  const random = deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(80));
  const now = deps.now?.() ?? Date.now();
  if (choice.kind === "ssg" && choice.adopt !== undefined) {
    const adopted = deps.format.planAdopt(
      { repositoryName, generator: GENERATOR, kind: "ssg", engine: choice.engine, vaults: [{ path: choice.adopt, encrypted: false }] },
      { ...gathered, gitignore: null },
      now,
      random,
    );
    if (!adopted.ok) throw kindRefusal(adopted.error);
    const [vault] = adopted.vaults;
    return { ok: true, files: adopted.files, repositoryId: adopted.repositoryId, vaultId: vault?.id ?? "", createdAt: adopted.createdAt };
  }
  if (choice.kind !== "drive") {
    const made: KindSetupResult =
      choice.kind === "journal"
        ? deps.format.planSetupKind({ repositoryName, generator: GENERATOR, kind: "journal", vault: choice.vault, encrypted: choice.encrypted, recipients: choice.recipients }, gathered, now, random)
        : deps.format.planSetupKind({ repositoryName, generator: GENERATOR, kind: "ssg", engine: choice.engine }, gathered, now, random);
    if (made.ok) return made;
    throw kindRefusal(made.error, choice.kind === "ssg");
  }
  const vault = choice.vault;
  const made = deps.format.planSetup({ repositoryName, vault, generator: GENERATOR }, gathered, now, random);
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
 * The files of a repository's first commit when it is made on this server (ROADMAP 3i): the same plan `applySetup` commits to a repository
 * that is not set up, made on an empty one, so a drive, a journal or anything else `fjord-core` plans is written by it and never by us.
 * A choice the plan refuses (a name it cannot use) throws a `ConnectionError`, as setting up does.
 */
export function planFirstCommit(deps: Pick<SetupDeps, "format" | "random" | "now">, repositoryName: string, choice: SetupChoice): Record<string, Uint8Array> {
  const made = plan(deps, repositoryName, choice, { paths: [], gitattributes: null });
  const encoder = new TextEncoder();
  return Object.fromEntries(made.files.map((file) => [file.path, encoder.encode(file.contents)]));
}

/** The words for what `planSetupKind` refused: the format module's message, with its code turned into one of ours. */
function kindRefusal(error: { code: string; message: string }, site = false): ConnectionError {
  switch (error.code) {
    case "already_fjord":
      return refused("already_fjord");
    case "gitattributes_not_read":
      return refused("gitattributes_unreadable");
    case "invalid_name":
    case "invalid_vault_name":
      return new ConnectionError("invalid_vault_name", error.message);
    case "name_taken":
    case "vault_name_taken":
      // A new site's vault has the name its engine reads: there is no other to choose.
      return new ConnectionError("vault_name_taken", site ? `${error.message}, and a new site keeps its posts there. Rename it in the repository first, or set this repository up as a drive.` : `${error.message}. Choose another name.`);
    case "file_taken":
      return new ConnectionError("file_taken", `${error.message}. Nothing was written.`);
    case "invalid_vault_path":
    case "nested_vaults":
    case "duplicate_vault":
      return new ConnectionError("invalid_vault_name", error.message);
    case "vault_exists":
    case "not_a_directory":
      return new ConnectionError("vault_name_taken", `${error.message}. Nothing was written.`);
    default:
      // A key that is not one, or a choice that does not go together: the module's own words say which.
      return new ConnectionError("invalid_vault_options", error.message);
  }
}

/** What a choice would write, for the page, or the words for why it cannot be made. */
function previewOf(deps: SetupDeps, repositoryName: string, choice: SetupChoice, gathered: { paths: string[]; gitattributes: string | null }): ChoicePreview {
  try {
    return { files: plan(deps, repositoryName, choice, gathered).files.map((file) => ({ path: file.path, change: file.change })) };
  } catch (error) {
    if (error instanceof ConnectionError) return { refused: error.message };
    throw error;
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
    const made = plan(deps, target.repositoryName, { kind: "drive", vault }, gathered);
    const journalVault = deps.format.freeVaultName(DEFAULT_JOURNAL_VAULT, gathered.paths);
    const kinds = {
      journal: previewOf(deps, target.repositoryName, { kind: "journal", vault: journalVault, encrypted: false, recipients: [] }, gathered),
      encryptedJournal: previewOf(deps, target.repositoryName, { kind: "journal", vault: journalVault, encrypted: true, recipients: [] }, gathered),
      astro: previewOf(deps, target.repositoryName, { kind: "ssg", engine: "astro" }, gathered),
      jekyll: previewOf(deps, target.repositoryName, { kind: "ssg", engine: "jekyll" }, gathered),
    };
    // A site that is already here (RFC 0002): its engine's files are at the root, and its content is where the engine reads it.
    const found = deps.format.detectSite(gathered.paths);
    const adoptSite = found === null ? null : { ...found, preview: previewOf(deps, target.repositoryName, { kind: "ssg", engine: found.engine, adopt: found.content }, gathered) };
    return { offer: true, preview: { vault, branch: read.branch, files: made.files.map((file) => ({ path: file.path, change: file.change })), kinds, adoptSite, journalVault } };
  } catch (error) {
    if (error instanceof ConnectionError && error.code === "gitattributes_unreadable") return { offer: false, refusal: { code: "gitattributes_unreadable", message: error.message } };
    throw error;
  }
}

/**
 * Set the repository up, with the vault named `vault`: one commit on the head as it is now. Throws a
 * `ConnectionError` saying what is wrong when it is not possible, and when the head moved since it was read.
 */
export async function applySetup(deps: SetupDeps, target: SetupTarget & { repositoryName: string }, choice: SetupChoice | string): Promise<{ commit: string }> {
  // A name alone is 1a.10's setup, a drive with that vault.
  const chosen: SetupChoice = typeof choice === "string" ? { kind: "drive", vault: choice } : choice;
  const read = await readRepository(deps, target);
  if (read.manifest !== null) throw refused("already_fjord");
  if (read.discovery.vaults.length > 0) throw refused("has_vaults");
  if (!(await deps.provider.canWrite(target.ref, target.branch))) throw refused("read_only");

  const gathered = await gather(deps, target, read.commit);
  const made = plan(deps, target.repositoryName, chosen, gathered);

  const encoder = new TextEncoder();
  const changes: Change[] = made.files.map((file) => ({ path: file.path, content: encoder.encode(file.contents) }));
  const appended = made.files.some((file) => file.change === "append");
  const message = setupMessage(chosen, appended);

  try {
    const result = await deps.provider.commit(target.ref, { branch: target.branch, expectedHead: read.commit, message, changes });
    return { commit: result.commit };
  } catch (error) {
    if (isProviderError(error, "head_moved")) throw refused("head_moved");
    if (isProviderError(error, "forbidden")) throw refused("read_only");
    throw error;
  }
}

/** The commit's message: what was added, in the words of the kind it was set up as. Names no file's contents. */
function setupMessage(choice: SetupChoice, appended: boolean): string {
  const guard = appended ? " Adds one line to .gitattributes, which spec §9 requires." : "";
  switch (choice.kind) {
    case "drive":
      return [`Set up Fjord: add the vault "${choice.vault}"`, "", `Adds fjord.json and the vault "${choice.vault}" (its manifest and a starter note), so that this repository is a Fjord repository.${guard} Nothing else that is here is changed.`].join("\n");
    case "journal":
      return [
        `Set up Fjord: a journal in "${choice.vault}"`,
        "",
        `Adds fjord.json, of the kind journal, and its vault "${choice.vault}"${choice.encrypted ? ", encrypted, with its recipients" : ""}, so that this repository is a Fjord journal.${guard} Nothing else that is here is changed.`,
      ].join("\n");
    case "ssg":
      if (choice.adopt !== undefined) {
        return [
          `Set up Fjord: this ${choice.engine === "astro" ? "Astro" : "Jekyll"} site, with "${choice.adopt}" as its vault`,
          "",
          `Adds fjord.json, of the kind ssg, and the vault manifest in "${choice.adopt}", where the site's engine already reads its content.${guard} Nothing that is here is changed or moved.`,
        ].join("\n");
      }
      return [
        `Set up Fjord: a ${choice.engine === "astro" ? "Astro" : "Jekyll"} site`,
        "",
        `Adds fjord.json, of the kind ssg, the vault "content" for the site's posts, and the ${choice.engine === "astro" ? "Astro" : "Jekyll"} project that builds them.${guard} Nothing else that is here is changed.`,
      ].join("\n");
  }
}

/** A kind a repository can be changed to, from its settings (ROADMAP 3a.3). */
export interface KindChange {
  kind: RepositoryKind;
  /** A site's. */
  engine?: SiteEngine;
}

/**
 * Change a Fjord repository's kind (spec §3.1): one commit of `fjord.json`, rewritten by the format module with every other field kept,
 * on the head as it is now. Refused, with the rule it breaks, when the repository does not keep the new kind's rules (a journal or a
 * site has exactly one vault, a site's is plaintext), and refused for a repository whose format is newer than this one's.
 */
export async function changeKind(deps: RepositoryDeps, target: SetupTarget, change: KindChange): Promise<{ commit: string }> {
  const read = await readRepository(deps, target);
  const manifest = read.manifest;
  if (manifest === null || !manifest.ok) throw new ConnectionError("manifest_unusable", "This repository has no fjord.json that can be read, so its kind cannot be changed here.");
  if (manifest.version !== null && manifest.version > deps.format.version) {
    throw new ConnectionError("newer_version", "This repository was made by a newer version of Fjord, so it can be read here but not changed.");
  }
  const broken = deps.format.kindRule(
    change.kind,
    read.discovery.vaults.map((vault) => vault.encrypted === true),
  );
  if (broken === "E111") throw new ConnectionError("kind_rule", `A ${KIND_LABELS[change.kind].toLowerCase()} has exactly one vault, and this repository has ${read.discovery.vaults.length}. Nothing was changed.`);
  if (broken === "E112") throw new ConnectionError("kind_rule", "A site's content is published, so its vault cannot be encrypted, and this repository's is. Nothing was changed.");

  const blob = read.blobs.get("fjord.json");
  if (blob === undefined) throw new ConnectionError("manifest_unusable", "This repository's fjord.json cannot be read, so its kind cannot be changed here.");
  const text = new TextDecoder().decode(await deps.provider.readBlob(target.ref, blob, { maxBytes: 256 * 1024 }));
  const rewritten = deps.format.withKind(text, change.kind, change.engine);
  if (!rewritten.ok) throw new ConnectionError("invalid_vault_options", rewritten.error.message);
  if (rewritten.text === text) return { commit: read.commit };

  const label = KIND_LABELS[change.kind].toLowerCase();
  const message = [`Make this repository a ${label}`, "", `Sets fjord.json's kind to ${change.kind}${change.engine ? `, built with ${change.engine}` : ""} (spec §3.1). No other file changes.`].join("\n");
  try {
    const done = await deps.provider.commit(target.ref, { branch: target.branch, expectedHead: read.commit, message, changes: [{ path: "fjord.json", content: new TextEncoder().encode(rewritten.text) }] });
    return { commit: done.commit };
  } catch (error) {
    if (isProviderError(error, "head_moved")) throw refused("head_moved");
    if (isProviderError(error, "forbidden")) throw refused("read_only");
    throw error;
  }
}

/** What each kind is called where a person reads it. The client's, not the format's (RFC 0001). */
export const KIND_LABELS: Record<RepositoryKind, string> = { drive: "Drive", journal: "Journal", ssg: "Site" };
