import type { Fjord } from "../format/wasm";
import type { VaultListing } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { formatIdentity } from "../working/version";

/**
 * A new post of a site (ROADMAP 3c.2, spec §3.1, Research 0001): one commit through the owner's token that adds one Markdown file where
 * the site's **engine** reads it, with what it reads.
 *
 *  - **Where and what are `fjord-core`'s** (`sitePostPath`, `siteNewPost`): Astro's `posts/<slug>.md` with a `draft` field, Jekyll's
 *    `_posts/YYYY-MM-DD-<slug>.md` (a name that is a rule, dated in the writer's day) or `_drafts/<slug>.md`.
 *  - **The date is the writer's**, sent as the moment and the writer's offset, as a journal entry's is.
 *  - **Never over anything**: a name that is taken takes a number.
 *  - **Where the vault is** is the site's: `content/` in one Fjord made, or the folder the engine already reads (`src/content`, `_posts`) in one adopted (RFC 0002).
 */
export interface PostDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "entryDateFromUnix" | "sitePostPath" | "siteNewPost" | "newUlid" | "rfc3339FromUnix">;
  now?: () => number;
  random?: () => Uint8Array;
}

export type PostResult = { ok: true; path: string; commit: string; date: string } | { ok: false; reason: "bad_date" | "draft_not_here" | "head_moved" | "read_only" | "bad_token" | "unavailable" };

/** Why a site cannot have posts made in it here. */
export type SiteRefusal = "not_a_site" | "unknown_engine" | "unsupported_site";

/** The one vault of a site, with its engine, if it is one a post can be made in: plaintext (a site is published), with plain names. */
export function siteVault(vaults: VaultListing[], engine: string | null): { vault: VaultListing; engine: "astro" | "jekyll" } | SiteRefusal {
  if (vaults.length !== 1) return "not_a_site";
  const vault = vaults[0] as VaultListing;
  if (engine !== "astro" && engine !== "jekyll") return "unknown_engine";
  if (vault.manifestError !== null || vault.encrypted !== false || vault.fileNaming !== "plain") return "unsupported_site";
  return { vault, engine };
}

const ATTEMPTS = 2;

export async function createPost(deps: PostDeps, input: { vault: string; engine: "astro" | "jekyll"; at: number; offsetMinutes: number; title: string; draft: boolean; author: Identity }): Promise<PostResult> {
  const date = deps.format.entryDateFromUnix(Math.floor(input.at / 1000), input.offsetMinutes);
  if (date === undefined) return { ok: false, reason: "bad_date" };
  const title = input.title.trim();
  let leaf = deps.format.sitePostPath(input.engine, date, title, input.draft);
  if (leaf === undefined) return { ok: false, reason: "bad_date" };
  // A Jekyll site adopted where its posts already are (spec §3.1): the vault *is* `_posts`, so the post goes in it and not in a `_posts` inside it, and
  // `_drafts`, which is beside it and outside the vault, cannot be written to.
  if (input.engine === "jekyll" && (input.vault === "_posts" || input.vault.endsWith("/_posts"))) {
    if (input.draft) return { ok: false, reason: "draft_not_here" };
    leaf = leaf.replace(/^_posts\//, "");
  }
  const now = deps.now?.() ?? Date.now();
  const id = deps.format.newUlid(now, deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const created = deps.format.rfc3339FromUnix(Math.floor(now / 1000));
  if (created === undefined) return { ok: false, reason: "bad_date" };
  const text = deps.format.siteNewPost(input.engine, id, title, created, date, input.draft);
  const author = formatIdentity(input.author);

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      const wanted = `${input.vault}/${leaf}`;
      const folder = wanted.slice(0, wanted.lastIndexOf("/"));
      const there = await deps.provider.listDirectory(deps.ref, expectedHead, folder).catch((error: unknown) => {
        if (isProviderError(error, "not_found")) return [];
        throw error;
      });
      const taken = new Set(there.map((entry) => entry.path.toLowerCase()));
      let path = wanted;
      for (let number = 2; taken.has(path.toLowerCase()); number++) path = `${wanted.slice(0, -".md".length)}-${number}.md`;

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          // A site is public by intent, and the title is in the repository anyway.
          message: title === "" ? `Add a ${input.draft ? "draft " : ""}post` : `Add a ${input.draft ? "draft " : ""}post: ${title}`,
          author,
          changes: [{ path, content: new TextEncoder().encode(text) }],
        });
        return { ok: true, path, commit: made.commit, date };
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
