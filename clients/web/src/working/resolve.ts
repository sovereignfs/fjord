import { readTextBlob } from "../browse/note";
import type { MergeResult } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Provider, RepositoryRef } from "../providers/types";
import type { Editor, WorkingCopy, WorkingCopyService } from "./service";
import { blobAt } from "./version";

/**
 * Going on after the file changed in the repository (DESIGN.md §11, ROADMAP 1b.10). A draft is of one version of a file
 * (its base). When the file at the branch's head is another blob (someone committed from the CLI, Obsidian or another
 * device), nothing is committed over it: the page shows both, and the person chooses.
 *
 *  - **Take theirs** is throwing the draft away (`DELETE`), and needs nothing here.
 *  - **Keep mine** moves the draft onto the file as it is now, its text unchanged. It is then an ordinary draft, and the
 *    next version is a commit on top of what is in the repository; what was there stays in its history.
 *  - **Combine** moves it onto the file as it is now with the two edits merged by `fjord-core`'s `merge3` (the CLI's own
 *    merge): where they overlap, both are in the text between conflict markers for the person to settle. Neither side is
 *    ever left out (spec §9.1).
 *
 * The server does the merging, from the blobs, so what the browser says is never the text. A choice is made only about the
 * version the person was shown (`upstreamBlob`): if the file changed again since, nothing happens and the page looks again.
 * Nothing here writes to the repository.
 */
export const OURS_LABEL = "Your changes";
export const THEIRS_LABEL = "In the repository";

export interface ResolveDeps {
  drafts: Pick<WorkingCopyService, "get" | "rebase">;
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: { mergeTexts(base: string, ours: string, theirs: string, labels: { ours: string; theirs: string }): MergeResult };
}

export type Choice = "mine" | "combine";

export type ResolveResult =
  | { ok: true; conflicts: number }
  | {
      ok: false;
      reason: "no_draft" | "up_to_date" | "gone" | "upstream_moved" | "draft_changed" | "unreadable" | "unstorable" | "bad_token" | "unavailable";
    };

/** What the page can say before the person chooses: whether the two edits combine without a conflict. */
export type Preview = { state: "clean" } | { state: "conflicts"; conflicts: number } | { state: "unavailable" };

const identityLabels = { ours: OURS_LABEL, theirs: THEIRS_LABEL };

/** Whether the draft and the file as it is now can be combined, found without changing anything. */
export async function previewCombine(provider: Provider, ref: RepositoryRef, format: ResolveDeps["format"], draft: WorkingCopy, upstreamText: string): Promise<Preview> {
  try {
    const base = await readTextBlob(provider, ref, draft.baseBlob);
    if (!base.ok) return { state: "unavailable" };
    const merged = format.mergeTexts(base.text, draft.content, upstreamText, identityLabels);
    return merged.clean ? { state: "clean" } : { state: "conflicts", conflicts: merged.conflicts };
  } catch (error) {
    // A host that cannot be asked just now is not a reason to refuse the page: the choice to combine is not offered.
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited") || isProviderError(error, "unauthorized")) return { state: "unavailable" };
    throw error;
  }
}

export async function resolveUpstream(deps: ResolveDeps, input: { connectionId: number; path: string; choice: Choice; upstreamBlob: string; editor: Editor }): Promise<ResolveResult> {
  const draft = await deps.drafts.get(input.connectionId, input.path);
  if (!draft) return { ok: false, reason: "no_draft" };

  try {
    const head = await deps.provider.getHead(deps.ref, deps.branch);
    if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
    const current = await blobAt(deps.provider, deps.ref, head.head.commit, input.path);
    if (current === undefined) return { ok: false, reason: "gone" };
    if (current === draft.baseBlob) return { ok: false, reason: "up_to_date" };
    if (current !== input.upstreamBlob) return { ok: false, reason: "upstream_moved" };

    let content = draft.content;
    let conflicts = 0;
    if (input.choice === "combine") {
      const [base, theirs] = [await readTextBlob(deps.provider, deps.ref, draft.baseBlob), await readTextBlob(deps.provider, deps.ref, current)];
      if (!base.ok || !theirs.ok) return { ok: false, reason: "unreadable" };
      const merged = deps.format.mergeTexts(base.text, draft.content, theirs.text, identityLabels);
      content = merged.text;
      conflicts = merged.conflicts;
    }

    const moved = await deps.drafts.rebase(input.connectionId, input.path, { fromBase: draft.baseBlob, toBase: current, content, lastEdit: draft.lastEdit }, input.editor);
    if (moved.ok) return { ok: true, conflicts };
    return { ok: false, reason: moved.reason === "changed" ? "draft_changed" : "unstorable" };
  } catch (error) {
    if (isProviderError(error, "unauthorized")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}
