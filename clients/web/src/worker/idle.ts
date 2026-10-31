import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { hasConflictMarkers } from "../working/markers";
import type { Editor, WorkingCopyService } from "../working/service";
import { type VersionResult, saveVersion } from "../working/version";

/**
 * Idle versions (DESIGN.md §11, ROADMAP 1b.13): a draft nobody has edited for the quiet period becomes a version, by the same
 * `saveVersion` that Save version uses, so every rule of 1b.9 holds (only on top of the draft's base, never forced, the draft ends
 * with its version, nothing typed meanwhile is lost). What is different is who is asked and who is credited.
 *
 *  - **Who is credited.** Nobody saved, so the author is the owner of the connection if they are among those who edited the draft
 *    (the commit is made through their token), else the first editor who can still be found; the others are `Co-authored-by:`.
 *    A draft none of whose editors can be found is left alone.
 *  - **Once.** A draft is committed once because it ends with its version. If two workers raced, the second finds the file changed
 *    (`upstream_changed`) or the draft gone, and writes nothing.
 *  - **Left for a person:** a draft with conflict markers in it (a combine was not finished) and one whose file changed upstream
 *    (1b.10 asks them to choose). So is a draft the host would not take (read-only or bad token), and one the host could not be
 *    reached for: each is tried again only after a delay, or when the draft is edited again, so a broken connection is not asked
 *    about every minute.
 */
export interface IdleTarget {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  ownerId: string;
}

export interface IdleDeps {
  drafts: Pick<WorkingCopyService, "idle" | "get" | "discardUnchanged">;
  /** The connection a draft is of, with its token; undefined if it is gone. */
  target: (connectionId: number) => Promise<IdleTarget | undefined>;
  identityOf: (editor: Editor) => Promise<Identity | undefined>;
  now: () => number;
  /** How long a draft is left alone after the last edit. */
  idleMs: number;
  /** How long a draft that could not be made a version is left alone. Defaults to fifteen minutes. */
  retryMs?: number;
  /** At most this many versions are made in one pass. Defaults to 50. */
  perPass?: number;
}

export type IdleOutcome = VersionResult | { ok: false; reason: "skipped_conflict" | "skipped_no_author" | "skipped_no_connection" | "failed" };

export interface IdleReport {
  made: number;
  /** Each draft looked at, as `connection:path`, and what came of it. */
  results: { connectionId: number; path: string; outcome: IdleOutcome }[];
}

const DEFAULT_RETRY_MS = 15 * 60 * 1000;
const DEFAULT_PER_PASS = 50;
/** Drafts looked at in one pass, before those still backed off are set aside. */
const WINDOW = 500;

export function createIdleVersions(deps: IdleDeps) {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const perPass = deps.perPass ?? DEFAULT_PER_PASS;
  /** Drafts not to try before a time, kept for the edit they had: another edit makes them new. */
  const backoff = new Map<string, { lastEdit: number; until: number }>();
  const keyOf = (connectionId: number, path: string) => `${connectionId}\u0000${path}`;

  async function attempt(connectionId: number, path: string): Promise<IdleOutcome> {
    const draft = await deps.drafts.get(connectionId, path);
    if (!draft) return { ok: false, reason: "no_draft" };
    if (hasConflictMarkers(draft.content)) return { ok: false, reason: "skipped_conflict" };
    const target = await deps.target(connectionId);
    if (!target) return { ok: false, reason: "skipped_no_connection" };

    const ordered = [...draft.editors].sort((a, b) => Number(!(a.type === "account" && a.id === target.ownerId)) - Number(!(b.type === "account" && b.id === target.ownerId)));
    let author: { identity: Identity; id: string } | undefined;
    for (const editor of ordered) {
      const identity = await deps.identityOf(editor);
      if (identity) {
        author = { identity, id: editor.type === "account" ? editor.id : "" };
        break;
      }
    }
    if (!author) return { ok: false, reason: "skipped_no_author" };

    return saveVersion(
      { drafts: deps.drafts, provider: target.provider, ref: target.ref, branch: target.branch, identityOf: deps.identityOf },
      { connectionId, path, message: undefined, author: author.identity, authorId: author.id },
    );
  }

  /** One look at the drafts that have been quiet long enough. */
  async function pass(): Promise<IdleReport> {
    const now = deps.now();
    const report: IdleReport = { made: 0, results: [] };
    const waiting = await deps.drafts.idle(now - deps.idleMs, WINDOW);

    const alive = new Set(waiting.map((draft) => keyOf(draft.connectionId, draft.path)));
    for (const key of backoff.keys()) if (!alive.has(key)) backoff.delete(key);

    for (const { connectionId, path, lastEdit } of waiting) {
      if (report.made >= perPass) break;
      const key = keyOf(connectionId, path);
      const held = backoff.get(key);
      if (held && held.lastEdit === lastEdit && held.until > now) continue;

      let outcome: IdleOutcome;
      try {
        outcome = await attempt(connectionId, path);
      } catch (error) {
        // Never the message: it may carry a path or a host's words. The name says what kind of failure it was.
        console.error(`[fjord] idle versions: unexpected ${error instanceof Error ? error.name : "failure"}`);
        outcome = { ok: false, reason: "failed" };
      }
      report.results.push({ connectionId, path, outcome });
      if (outcome.ok) {
        report.made++;
        backoff.delete(key);
      } else if (outcome.reason !== "no_draft" && outcome.reason !== "nothing_to_save") {
        backoff.set(key, { lastEdit, until: now + retryMs });
      }
    }
    return report;
  }

  return { pass };
}
