import { createHash } from 'node:crypto';
import { isProviderError } from '../providers/errors';
import type { BuildStatus, Identity, Provider, RepositoryRef } from '../providers/types';
import type { WorkingCopy, WorkingCopyService } from '../working/service';
import { formatIdentity } from '../working/version';

/**
 * Previewing a site's unsaved changes through its host (ROADMAP 3d.1, Research 0001): the person's drafts in the site are committed to a **branch of
 * their own**, the host (Cloudflare Pages, Netlify, Vercel…) builds that branch as it builds any, and Fjord shows the address the host gives for
 * **that commit**. Fjord builds nothing and holds no credential of the host's: the address comes from the deployment the host posted to the repository,
 * which the connection's own token reads (`getBuildStatus`).
 *
 * The rules that make it safe to offer:
 *
 *  - **Never the default branch, and never forced.** A preview is a new branch, cut from the default branch's head, with one commit of the drafts. A
 *    branch that is there is never reset; the default branch is only ever read. Deleting is only of a branch of this person's preview namespace.
 *  - **The branch's life is the preview's.** One branch per preview, named `fjord/preview/<person>-<time>`, kept until the person stops it
 *    (deleting the branch), and at most `MAX_PREVIEWS` at once so they cannot pile up. There is no timer that deletes a branch: a repository's
 *    history is not Fjord's to prune behind its owner's back.
 *  - **Only what is the person's and is still good.** The drafts of the site's vault, plaintext, whose base is still the file at the head: a draft of a
 *    file that changed upstream is left out and named, since putting it in would write over the change. A site's content is never encrypted.
 *  - **A host that previews no branches is told so**, after `WAIT_MS`, rather than left waiting for ever.
 */
export const PREVIEW_PREFIX = 'fjord/preview/';
export const MAX_PREVIEWS = 3;
/** How long a branch can be at a commit with nothing reported before the host is taken not to build branches. */
export const WAIT_MS = 3 * 60_000;

/** The part of a branch name that is this person's: a hash, so the name says nothing of who they are in a repository others can read. */
export const personTag = (accountId: string): string =>
  createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 8);

/** `20261102t220000z`: lower case, since a branch name in a repository others read is plainer so. */
const stamp = (at: number): string =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .toLowerCase();

/** `fjord/preview/<person>-<YYYYMMDDtHHMMSSZ>`, the time being the preview's start. */
export const branchName = (accountId: string, at: number, attempt = 1): string =>
  `${PREVIEW_PREFIX}${personTag(accountId)}-${stamp(at)}${attempt > 1 ? `-${attempt}` : ''}`;

/** When a preview branch was started, from its name; undefined for one that is not named as these are. */
export function startedAt(branch: string): number | undefined {
  const found = /-(\d{4})(\d\d)(\d\d)t(\d\d)(\d\d)(\d\d)z(?:-\d+)?$/.exec(branch);
  if (!found) return undefined;
  const [, y, mo, d, h, mi, s] = found.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Whether `branch` is one of this person's previews: the only branches this module ever deletes. */
export const isPreviewOf = (accountId: string, branch: string): boolean =>
  branch.startsWith(`${PREVIEW_PREFIX}${personTag(accountId)}-`) && startedAt(branch) !== undefined;

export type PreviewOutcome =
  /** The host has been told and has said nothing yet. */
  | { kind: 'waiting' }
  | { kind: 'building' }
  /** Built, and the host says where. */
  | { kind: 'ready'; url: string }
  /** Built, and the host did not say where the site is. */
  | { kind: 'built' }
  | { kind: 'failed'; url?: string | undefined }
  /** Nothing reported for longer than `WAIT_MS`: this host does not build branches (or is not set up to). */
  | { kind: 'unsupported' }
  /** The token may not read what a host reports (Checks, Commit statuses, Deployments), so how it stands is not known. */
  | { kind: 'unreadable' };

/** Where a preview stands, from what the host reports of its commit and how long ago it was started. Pure. */
export function outcomeOf(
  status: BuildStatus,
  started: number,
  now: number,
  waitMs = WAIT_MS,
): PreviewOutcome {
  switch (status.state) {
    case 'none':
      return now - started > waitMs ? { kind: 'unsupported' } : { kind: 'waiting' };
    case 'pending':
      return { kind: 'building' };
    case 'failure':
      return { kind: 'failed', url: status.checks.find((check) => check.state === 'failure')?.url };
    case 'success':
      return status.siteUrl !== undefined
        ? { kind: 'ready', url: status.siteUrl }
        : { kind: 'built' };
  }
}

export interface PreviewDeps {
  provider: Provider;
  ref: RepositoryRef;
  /** The default branch: what a preview is cut from, and never written. */
  defaultBranch: string;
  drafts: Pick<WorkingCopyService, 'paths' | 'get'>;
  connectionId: number;
  /** The site's vault, whose drafts are previewed. */
  vault: string;
  now?: () => number;
}

/** What a preview would be made of, found without writing anything. */
export interface Candidates {
  /** Drafts that go into a preview. */
  files: { path: string; content: string }[];
  /** Drafts left out, and why. */
  skipped: { path: string; reason: 'changed_upstream' | 'not_text' | 'gone' }[];
  /** The commit the preview would be cut from. */
  base: string;
}

/** The person's drafts in the site that a preview would hold, as they stand against the default branch's head. */
export async function candidates(
  deps: PreviewDeps,
  accountId: string,
): Promise<Candidates | { ok: false; reason: 'too_large' }> {
  const head = await deps.provider.getHead(deps.ref, deps.defaultBranch);
  if (!head.changed) throw new Error('the host answered a head request with no etag as unchanged');
  const tree = await deps.provider.getTree(deps.ref, head.head.commit);
  if (!tree.complete) return { ok: false, reason: 'too_large' };
  const blobs = new Map(
    tree.entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.id]),
  );

  const files: Candidates['files'] = [];
  const skipped: Candidates['skipped'] = [];
  for (const path of await deps.drafts.paths(deps.connectionId)) {
    if (!path.startsWith(`${deps.vault}/`)) continue;
    const draft: WorkingCopy | undefined = await deps.drafts.get(deps.connectionId, path);
    // A draft that more than the person has edited is still theirs to preview if they are among its editors.
    if (
      !draft ||
      !draft.editors.some((editor) => editor.type === 'account' && editor.id === accountId)
    )
      continue;
    if (draft.encrypted) {
      skipped.push({ path, reason: 'not_text' });
      continue;
    }
    const current = blobs.get(path);
    if (current === undefined) skipped.push({ path, reason: 'gone' });
    else if (current !== draft.baseBlob) skipped.push({ path, reason: 'changed_upstream' });
    else files.push({ path, content: draft.content });
  }
  return { files, skipped, base: head.head.commit };
}

export type StartResult =
  | { ok: true; branch: string; commit: string; files: string[]; skipped: Candidates['skipped'] }
  | {
      ok: false;
      reason:
        'too_many' | 'nothing_to_preview' | 'too_large' | 'read_only' | 'bad_token' | 'unavailable';
      skipped?: Candidates['skipped'];
    };

/** Start a preview: a branch at the default branch's head, and one commit of the drafts on it. The default branch is not written. */
export async function startPreview(
  deps: PreviewDeps,
  input: { accountId: string; author: Identity },
): Promise<StartResult> {
  const now = deps.now ?? Date.now;
  try {
    const mine = (
      await deps.provider.listBranches(deps.ref, `${PREVIEW_PREFIX}${personTag(input.accountId)}-`)
    ).filter((entry) => isPreviewOf(input.accountId, entry.branch));
    if (mine.length >= MAX_PREVIEWS) return { ok: false, reason: 'too_many' };

    const found = await candidates(deps, input.accountId);
    if ('ok' in found) return { ok: false, reason: found.reason };
    if (found.files.length === 0)
      return { ok: false, reason: 'nothing_to_preview', skipped: found.skipped };

    let branch = '';
    for (let attempt = 1; ; attempt++) {
      branch = branchName(input.accountId, now(), attempt);
      try {
        await deps.provider.createBranch(deps.ref, branch, found.base);
        break;
      } catch (error) {
        // A name taken in the same second is a second preview: it takes the next.
        if (isProviderError(error, 'branch_exists') && attempt < 5) continue;
        throw error;
      }
    }

    try {
      const made = await deps.provider.commit(deps.ref, {
        branch,
        expectedHead: found.base,
        message: `Preview of ${found.files.length === 1 ? 'an unsaved change' : `${found.files.length} unsaved changes`} (Fjord)`,
        author: formatIdentity(input.author),
        changes: found.files.map((file) => ({
          path: file.path,
          content: new TextEncoder().encode(file.content),
        })),
      });
      return {
        ok: true,
        branch,
        commit: made.commit,
        files: found.files.map((file) => file.path),
        skipped: found.skipped,
      };
    } catch (error) {
      // The branch was made for this and holds nothing: it is let go, so that a refused preview leaves nothing behind.
      await deps.provider.deleteBranch(deps.ref, branch).catch(() => undefined);
      if (isProviderError(error, 'no_changes'))
        return { ok: false, reason: 'nothing_to_preview', skipped: found.skipped };
      throw error;
    }
  } catch (error) {
    if (isProviderError(error, 'forbidden')) return { ok: false, reason: 'read_only' };
    if (isProviderError(error, 'unauthorized')) return { ok: false, reason: 'bad_token' };
    if (
      isProviderError(error, 'not_found') ||
      isProviderError(error, 'unavailable') ||
      isProviderError(error, 'rate_limited')
    )
      return { ok: false, reason: 'unavailable' };
    throw error;
  }
}

export interface PreviewView {
  branch: string;
  commit: string;
  startedAt: number;
  outcome: PreviewOutcome;
  /** What the host reports, for the person to follow. */
  checks: BuildStatus['checks'];
}

/** The person's previews, each with where it stands. A host that cannot be asked about one leaves it `waiting`, not missing; a token that may not read it says so. */
export async function previewsOf(deps: PreviewDeps, accountId: string): Promise<PreviewView[]> {
  const now = (deps.now ?? Date.now)();
  const branches = (
    await deps.provider.listBranches(deps.ref, `${PREVIEW_PREFIX}${personTag(accountId)}-`)
  ).filter((entry) => isPreviewOf(accountId, entry.branch));
  const out: PreviewView[] = [];
  for (const entry of branches) {
    const started = startedAt(entry.branch) ?? now;
    let status: BuildStatus = { commit: entry.commit, state: 'none', checks: [] };
    try {
      // The status of the preview's own commit: never the default branch's, whose site is another site.
      status = await deps.provider.getBuildStatus(deps.ref, entry.commit);
    } catch (error) {
      if (isProviderError(error, 'forbidden')) {
        out.push({
          branch: entry.branch,
          commit: entry.commit,
          startedAt: started,
          outcome: { kind: 'unreadable' },
          checks: [],
        });
        continue;
      }
      // The host could not be asked just now: the preview is still there, and is asked about again.
    }
    out.push({
      branch: entry.branch,
      commit: entry.commit,
      startedAt: started,
      outcome: outcomeOf(status, started, now),
      checks: status.checks,
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export type StopResult =
  | { ok: true }
  | { ok: false; reason: 'not_yours' | 'gone' | 'read_only' | 'bad_token' | 'unavailable' };

/** Stop a preview: delete its branch. Only a branch of this person's previews, whatever name is given. */
export async function stopPreview(
  deps: PreviewDeps,
  input: { accountId: string; branch: string },
): Promise<StopResult> {
  if (!isPreviewOf(input.accountId, input.branch) || input.branch === deps.defaultBranch)
    return { ok: false, reason: 'not_yours' };
  try {
    await deps.provider.deleteBranch(deps.ref, input.branch);
    return { ok: true };
  } catch (error) {
    if (isProviderError(error, 'not_found')) return { ok: false, reason: 'gone' };
    if (isProviderError(error, 'forbidden')) return { ok: false, reason: 'read_only' };
    if (isProviderError(error, 'unauthorized')) return { ok: false, reason: 'bad_token' };
    if (isProviderError(error, 'unavailable') || isProviderError(error, 'rate_limited'))
      return { ok: false, reason: 'unavailable' };
    throw error;
  }
}
