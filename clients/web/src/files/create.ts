import type { Fjord } from "../format/wasm";
import type { LocalMinute, VaultListing } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { formatIdentity } from "../working/version";

/**
 * Making a new note or document (DESIGN.md §10, ROADMAP 1b.7): one commit through the owner's token, on the branch the
 * repository was connected with, that adds one file to a vault's folder. Never forced, and nothing else in the commit.
 *
 *  - **The name is `fjord-core`'s**, the one every client uses (a phone's quick note, the CLI's): a note from its first
 *    line, else from the writer's local date and time; a document from its title, with `.fj.md`; numbered past what the
 *    folder already has, case aside (spec §5). It is worked out against the folder **at the head the commit goes on top
 *    of**, so when someone adds the same name meanwhile the head has moved, the folder is read again, and the next free
 *    name is taken: two files made at one path are two files.
 *  - **A document's header is `fjord-core`'s** too (`id`, `title`, `created`), with an identifier from the clock and the
 *    randomness given. A note is the heading its title makes, or an empty file when no title was given.
 *  - **Only into a folder that is there**: git has no empty directories, so a folder with nothing in it is not one.
 *    Making new folders is not part of this.
 *
 * Which vaults may be written to (plaintext ones) is decided before this is called.
 */
export interface CreateDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "quickNoteName" | "titleFromText" | "freeName" | "newDocument" | "newUlid" | "rfc3339FromUnix">;
  /** For tests: milliseconds since the epoch. */
  now?: () => number;
  /** For tests: at least ten random bytes. */
  random?: () => Uint8Array;
}

export type FileKind = "note" | "document";

/** Why a vault cannot be written to, found before anything is: it is not in the repository, is encrypted (files cannot be made there in this version), or is not one this version writes (a manifest it cannot read, or names that are not plain). */
export type VaultRefusal = "unknown_vault" | "encrypted_vault" | "unsupported_vault";

/** Whether files may be made in the vault called `directory`, among the vaults a repository has. */
export function checkVault(vaults: VaultListing[], directory: string): "ok" | VaultRefusal {
  const vault = vaults.find((candidate) => candidate.directory === directory);
  if (!vault) return "unknown_vault";
  if (vault.manifestError !== null) return "unsupported_vault";
  if (vault.encrypted === true) return "encrypted_vault";
  return vault.encrypted === false && vault.fileNaming === "plain" ? "ok" : "unsupported_vault";
}

export type CreateResult =
  | { ok: true; path: string; commit: string }
  | { ok: false; reason: "folder_gone" | "bad_title" | "head_moved" | "read_only" | "bad_token" | "unavailable" };

/** A title, at most this long (the name made from it is shorter). */
export const MAX_TITLE_CHARS = 200;
const ATTEMPTS = 2;
const DOCUMENT_EXTENSION = ".fj.md";

export async function createFile(
  deps: CreateDeps,
  input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: LocalMinute; author: Identity },
): Promise<CreateResult> {
  const title = input.title.trim();
  if (input.kind === "document" && deps.format.titleFromText(title) === null) return { ok: false, reason: "bad_title" };
  const directory = input.folder === "" ? input.vault : `${input.vault}/${input.folder}`;
  const author = formatIdentity(input.author);

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      const entries = await deps.provider.listDirectory(deps.ref, expectedHead, directory).catch((error: unknown) => {
        if (isProviderError(error, "not_found")) return [];
        throw error;
      });
      // A vault always has its manifest; any other folder is only there if something is in it.
      if (entries.length === 0) return { ok: false, reason: "folder_gone" };
      const taken = entries.map((entry) => entry.path.slice(directory.length + 1));

      const { name, text } = nameAndText(deps, input.kind, title, taken, input.localMinute);
      const path = `${directory}/${name}`;
      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: `Create ${name.endsWith(DOCUMENT_EXTENSION) ? name.slice(0, -DOCUMENT_EXTENSION.length) : name.replace(/\.md$/i, "")}`,
          author,
          changes: [{ path, content: new TextEncoder().encode(text) }],
        });
        return { ok: true, path, commit: made.commit };
      } catch (error) {
        if (isProviderError(error, "head_moved")) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: "head_moved" };
        }
        throw error;
      }
    }
  } catch (error) {
    if (isProviderError(error, "forbidden")) return { ok: false, reason: "read_only" };
    if (isProviderError(error, "unauthorized")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}

function nameAndText(deps: CreateDeps, kind: FileKind, title: string, taken: string[], when: LocalMinute): { name: string; text: string } {
  if (kind === "note") {
    const text = title === "" ? "" : `# ${title}\n`;
    return { name: deps.format.quickNoteName(text, taken, when), text };
  }
  const stem = deps.format.titleFromText(title) as string; // checked by the caller of this
  const now = deps.now?.() ?? Date.now();
  const id = deps.format.newUlid(now, deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const created = deps.format.rfc3339FromUnix(Math.floor(now / 1000));
  return { name: deps.format.freeName(stem, DOCUMENT_EXTENSION, taken), text: deps.format.newDocument(id, title, created) };
}
