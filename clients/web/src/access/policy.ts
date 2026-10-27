/**
 * Who may do what to a document (DESIGN.md §12, ROADMAP 1c.1): the one place that says, in code, what a role is and what
 * each way of being let in allows. Nothing else in the app decides this; a route or a screen asks `decide` and does what
 * it is told, so that a role means one thing wherever it is checked and the rules can be held to a table.
 *
 * It is a pure function of the grants someone holds, the action, what it is done to and the time. Finding the grants (the
 * owner of a connection, a named-user share, a link's session) is the caller's, and comes with each way to share (1c.2,
 * 1c.3); this does not know where they came from, only what they are.
 *
 * **Roles each include the ones before them** (§12): view reads; comment also comments, replies and resolves; edit also
 * edits, into the working copy. A role never allows making a version, renaming, moving, deleting, restoring or sharing: those
 * are the owner's in phase 1 (§8, §11, §12), and a share cannot be given them. **Only documents are shared** (`*.fj.md`):
 * a note, a folder or a file in an encrypted vault (shared in phase 2, as sealed copies) has no share to hold.
 */
export const ROLES = ["view", "comment", "edit"] as const;
export type Role = (typeof ROLES)[number];

/** How someone is let in. A share that has expired or been revoked is a grant that allows nothing. */
export type Grant =
  | { kind: "owner" }
  /** A named account of the instance (§12). */
  | { kind: "user"; role: Role }
  /** A link; `expiresAt` is epoch milliseconds, and `revoked` ends it at once (§12). */
  | { kind: "link"; role: Role; expiresAt?: number | null; revoked?: boolean };

export const ACTIONS = [
  "read",
  "comment",
  "reply",
  "resolve",
  "edit_own_comment",
  "delete_own_comment",
  "moderate_comments",
  "edit",
  "save_version",
  "create",
  "rename",
  "move",
  "delete",
  "restore",
  "manage_shares",
] as const;
export type Action = (typeof ACTIONS)[number];

/** What an action is done to. `encrypted` is a file of an encrypted vault, which phase 1 does not share. */
export type Target = { kind: "document" | "note" | "folder"; encrypted?: boolean };

/** Role by role, what it adds to the one before (§12). */
const ADDED: Record<Role, readonly Action[]> = {
  view: ["read"],
  comment: ["comment", "reply", "resolve", "edit_own_comment", "delete_own_comment"],
  edit: ["edit"],
};

/** What a role allows: its own and everything of the roles before it. */
export function actionsOf(role: Role): ReadonlySet<Action> {
  const out = new Set<Action>();
  for (const each of ROLES) {
    for (const action of ADDED[each]) out.add(action);
    if (each === role) break;
  }
  return out;
}

/** Whether a grant still lets anyone in: an owner always does; a link only before it expires and until it is revoked. */
export function isLive(grant: Grant, now: number): boolean {
  if (grant.kind !== "link") return true;
  if (grant.revoked === true) return false;
  return grant.expiresAt === undefined || grant.expiresAt === null || grant.expiresAt > now;
}

/** The most someone is let do: `owner`, the highest role among the grants that are live, or nothing. */
export function effectiveRole(grants: readonly Grant[], now: number): "owner" | Role | null {
  let best: Role | null = null;
  for (const grant of grants) {
    if (!isLive(grant, now)) continue;
    if (grant.kind === "owner") return "owner";
    if (best === null || ROLES.indexOf(grant.role) > ROLES.indexOf(best)) best = grant.role;
  }
  return best;
}

/**
 * - `allow`: do it.
 * - `forbidden`: they are let in, but not to this (a viewer who tries to comment). The page may say so.
 * - `hidden`: they are not let in at all, or there is nothing here for them to be let into (a share on a note, an expired
 *   link, someone else's file): answered as if it were not there, so that it does not say whether it is (§12).
 */
export type Decision = "allow" | "forbidden" | "hidden";

export function decide(grants: readonly Grant[], action: Action, target: Target, now: number): Decision {
  const role = effectiveRole(grants, now);
  if (role === null) return "hidden";
  if (role === "owner") return "allow";
  // A share is of a document, in a plaintext vault: for anything else there is no share, so there is nothing to reveal.
  if (target.kind !== "document" || target.encrypted === true) return "hidden";
  return actionsOf(role).has(action) ? "allow" : "forbidden";
}

export const can = (grants: readonly Grant[], action: Action, target: Target, now: number): boolean => decide(grants, action, target, now) === "allow";

/** The HTTP status of a refusal: 404 for what is hidden, 403 for what is let in and not to this. */
export const statusOf = (decision: Exclude<Decision, "allow">): 403 | 404 => (decision === "forbidden" ? 403 : 404);
