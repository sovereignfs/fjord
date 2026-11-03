import type { Fjord } from "../format/wasm";
import type { LocalMinute, VaultListing } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { formatIdentity } from "../working/version";

/**
 * Making a new document (DESIGN.md §10, ROADMAP 1b.7; one kind of Doc, RFC 0002): one commit through the owner's token, on the branch the
 * repository was connected with, that adds one file to a vault's folder. Never forced, and nothing else in the commit.
 *
 *  - **The name is `fjord-core`'s**, the one every client uses (a phone's quick note, the CLI's): from the title, else from
 *    the writer's local date and time; always `.md`; numbered past what the folder already has, case aside (spec §5). It is worked out against the folder **at the head the commit goes on top
 *    of**, so when someone adds the same name meanwhile the head has moved, the folder is read again, and the next free
 *    name is taken: two files made at one path are two files.
 *  - **The header is `fjord-core`'s** too (`id`, `title`, `created`), with an identifier from the clock and the
 *    randomness given: a file Fjord makes has an `id` from the start. With no title the date and time that named the file
 *    is its title, as `fjord new` does with a file's stem.
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

import { createMessage, render } from "./messages";

/** Why a vault cannot be written to, found before anything is: it is not in the repository, is encrypted (files cannot be made there in this version), or is not one this version writes (a manifest it cannot read, or names that are not plain). */
export type VaultRefusal = "unknown_vault" | "encrypted_vault" | "unsupported_vault";

/** Whether files may be made in the vault called `directory`, among the vaults a repository has. */
export function checkVault(vaults: VaultListing[], directory: string): "ok" | VaultRefusal {
  // A vault's directory, or a path inside one (a vault may be below the root, spec §2.3): the vault is the one that holds it.
  const vault = vaults.find((candidate) => candidate.directory === directory) ?? vaults.find((candidate) => directory.startsWith(`${candidate.directory}/`));
  if (!vault) return "unknown_vault";
  if (vault.manifestError !== null) return "unsupported_vault";
  if (vault.encrypted === true) return "encrypted_vault";
  return vault.encrypted === false && vault.fileNaming === "plain" ? "ok" : "unsupported_vault";
}

export type CreateResult =
  | { ok: true; path: string; commit: string }
  | { ok: false; reason: "folder_gone" | "bad_title" | "head_moved" | "read_only" | "bad_token" | "unavailable" };

export { MAX_TITLE_CHARS } from "./limits";
const ATTEMPTS = 2;
export async function createFile(
  deps: CreateDeps,
  input: { vault: string; folder: string; title: string; localMinute: LocalMinute; author: Identity },
): Promise<CreateResult> {
  const title = input.title.trim();
  if (title !== "" && deps.format.titleFromText(title) === null) return { ok: false, reason: "bad_title" };
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

      const { name, text } = nameAndText(deps, title, taken, input.localMinute);
      const path = `${directory}/${name}`;
      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: render(createMessage({ path, text })),
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

function nameAndText(deps: CreateDeps, title: string, taken: string[], when: LocalMinute): { name: string; text: string } {
  const now = deps.now?.() ?? Date.now();
  const id = deps.format.newUlid(now, deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const created = deps.format.rfc3339FromUnix(Math.floor(now / 1000));
  // From the title (checked by the caller: it has something to name a file by), else from the date and time.
  const name = title === "" ? deps.format.quickNoteName("", taken, when) : deps.format.freeName(deps.format.titleFromText(title) as string, ".md", taken);
  return { name, text: deps.format.newDocument(id, title === "" ? name.replace(/\.md$/i, "") : title, created) };
}
