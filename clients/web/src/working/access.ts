import type { Identity } from "../providers/types";
import type { Deps, SaveOutcome } from "./http";
import type { Editor, WorkingCopyService } from "./service";
import type { VersionResult } from "./version";

/**
 * Who may keep a draft of what, and when the git host is asked (ROADMAP 1b.8). `http.ts` has the request's rules; this
 * has the repository's:
 *
 *  - The connection must be the caller's. Another's is "not found", and nothing is read or kept.
 *  - **A draft is started only for an editable note**: a file that is, in the repository as it is now, a note in a
 *    plaintext vault. That asks the git host, so it is asked once, when the draft is started, and not at every save: a
 *    draft that exists was already checked, and saving it is a write to our own database and nothing else.
 *  - What is kept is attributed to the caller (`Editor`), who is added to those who have edited it.
 *  - A version is made only for a connection of the caller's, and only from a draft that is there (`version.ts`).
 */
export interface AccessDeps {
  service: Pick<WorkingCopyService, "get" | "save" | "discard">;
  /** Whether the connection is this account's. */
  owns: (accountId: string, id: number) => Promise<boolean>;
  /** Whether `path` is an editable note of the connection's repository now; `unavailable` if the host could not be asked. */
  editableNote: (accountId: string, id: number, path: string) => Promise<"yes" | "no" | "unavailable">;
  /** Make the version, through the connection's own token. Only called for a connection that is the caller's. */
  version: (accountId: string, id: number, input: { path: string; message: string | undefined; author: Identity }) => Promise<VersionResult>;
}

export function workingCopyAccess(deps: AccessDeps): Pick<Deps, "save" | "discard" | "saveVersion"> {
  return {
    async saveVersion(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      return { found: true, result: await deps.version(accountId, id, input) };
    },

    async save(accountId, id, input): Promise<SaveOutcome> {
      if (!(await deps.owns(accountId, id))) return { found: false };
      if ((await deps.service.get(id, input.path)) === undefined) {
        const editable = await deps.editableNote(accountId, id, input.path);
        if (editable !== "yes") return { found: true, result: { ok: false, reason: editable === "no" ? "not_editable" : "unavailable" } };
      }
      const editor: Editor = { type: "account", id: accountId };
      return { found: true, result: await deps.service.save(id, input.path, { baseBlob: input.baseBlob, content: input.content }, editor) };
    },

    async discard(accountId, id, path) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      await deps.service.discard(id, path);
      return { found: true };
    },
  };
}
