import type { DocIndex } from "../browse/doc-index";
import type { Source } from "../browse/ids";
import type { Fjord } from "../format/wasm";
import { readDocument } from "../sharing/open";
import { TOKEN_PATTERN } from "../sharing/tokens";
import type { PublicationService } from "./publications";
import { renderMarkdown } from "./render";

/**
 * A published page, for whoever has its address (DESIGN.md §12, ROADMAP 3h.1): the Doc as it is on the repository's default branch **now** (a draft the owner has
 * not saved as a version is never shown), read with the owner's token, its body rendered by the allowlist in `render.ts`. A token that is not one, or was never made,
 * or was ended, and a Doc that is gone, are all the same answer: nothing. What is shown is the title and the rendered body; not the path, the header or anything else
 * of the repository. A page published from an encrypted vault (ROADMAP 3h.2) is the plaintext copy the owner's browser handed over, shown the same way.
 */
export interface OpenPublishedDeps {
  publications: Pick<PublicationService, "find">;
  sourceOf: (connectionId: number) => Promise<Source | undefined>;
  index: DocIndex;
  format: Pick<Fjord, "parseDocument" | "impliedTitle">;
}

export async function openPublished(deps: OpenPublishedDeps, token: string): Promise<{ title: string; html: string } | undefined> {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const found = await deps.publications.find(token);
  if (!found) return undefined;
  // A page published from an encrypted vault is the copy that was handed over: there is nothing the server could read.
  if (found.copy) return { title: found.copy.title, html: renderMarkdown(found.copy.body) };
  const doc = await readDocument(deps, found.connectionId, found.docId);
  if (!doc) return undefined;
  return { title: doc.title, html: renderMarkdown(doc.body) };
}
