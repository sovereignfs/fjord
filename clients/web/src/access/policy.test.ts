import { describe, expect, it } from "vitest";
import { ACTIONS, type Action, type Grant, ROLES, type Role, type Target, can, decide, effectiveRole, isLive, statusOf } from "./policy";

/**
 * Who may do what (DESIGN.md §12, ROADMAP 1c.1): the matrix of roles × actions × ways of being let in, written out here by
 * hand from the design and not derived from the code under test, so that the code is held to the table and not to itself.
 */
const NOW = 1_800_000_000_000;
const DOC: Target = { kind: "document" };

/** §12's table, role by role, in full (each role includes the ones before it). */
const ALLOWED: Record<Role, Action[]> = {
  view: ["read"],
  comment: ["read", "comment", "reply", "resolve", "edit_own_comment", "delete_own_comment"],
  edit: ["read", "comment", "reply", "resolve", "edit_own_comment", "delete_own_comment", "edit"],
};
/** What only the owner does in phase 1: no share can be given any of it (§8, §11, §12). */
const OWNER_ONLY: Action[] = ["moderate_comments", "save_version", "create", "rename", "move", "delete", "restore", "manage_shares"];

const ways: [string, (role: Role) => Grant][] = [
  ["a named user", (role) => ({ kind: "user", role })],
  ["a link", (role) => ({ kind: "link", role })],
  ["a link that expires later", (role) => ({ kind: "link", role, expiresAt: NOW + 1 })],
];

describe("the roles", () => {
  it("are three, each including the ones before", () => {
    expect([...ROLES]).toEqual(["view", "comment", "edit"]);
    for (const [lower, higher] of [["view", "comment"], ["comment", "edit"]] as const) for (const action of ALLOWED[lower]) expect(ALLOWED[higher]).toContain(action);
  });

  it("have every action accounted for: a role's, or the owner's alone", () => {
    expect([...ALLOWED.edit, ...OWNER_ONLY].sort()).toEqual([...ACTIONS].sort());
  });
});

describe.each(ways)("%s, on a document", (_name, grant) => {
  for (const role of ROLES) {
    describe(`with the ${role} role`, () => {
      for (const action of ACTIONS) {
        const allowed = ALLOWED[role].includes(action);
        it(`${allowed ? "may" : "may not"} ${action}${allowed ? "" : ", and is told it is not theirs to do"}`, () => {
          expect(can([grant(role)], action, DOC, NOW)).toBe(allowed);
          expect(decide([grant(role)], action, DOC, NOW)).toBe(allowed ? "allow" : "forbidden");
        });
      }
    });
  }
});

describe("the owner", () => {
  it("may do everything, to anything", () => {
    for (const action of ACTIONS) for (const target of [DOC, { kind: "note" }, { kind: "folder" }, { kind: "document", encrypted: true }] as Target[]) {
      expect(decide([{ kind: "owner" }], action, target, NOW), `${action} ${JSON.stringify(target)}`).toBe("allow");
    }
  });

  it("is not made less by a share it also holds", () => {
    expect(can([{ kind: "user", role: "view" }, { kind: "owner" }], "delete", DOC, NOW)).toBe(true);
  });
});

describe("what is not a document", () => {
  const targets: [string, Target][] = [
    ["a note", { kind: "note" }],
    ["a folder", { kind: "folder" }],
    ["a document in an encrypted vault", { kind: "document", encrypted: true }],
  ];
  it.each(targets)("%s has no share, so a share finds nothing there, whatever the role and the action", (_name, target) => {
    for (const [, grant] of ways) for (const role of ROLES) for (const action of ACTIONS) expect(decide([grant(role)], action, target, NOW)).toBe("hidden");
  });
});

describe("a link that is no longer one", () => {
  const dead: [string, Grant][] = [
    ["has expired", { kind: "link", role: "edit", expiresAt: NOW - 1 }],
    ["expires this instant", { kind: "link", role: "edit", expiresAt: NOW }],
    ["was revoked", { kind: "link", role: "edit", revoked: true }],
    ["was revoked and has not expired", { kind: "link", role: "edit", revoked: true, expiresAt: NOW + 1000 }],
  ];
  it.each(dead)("%s: nothing is allowed, and it is as if there were none", (_name, grant) => {
    expect(isLive(grant, NOW)).toBe(false);
    for (const action of ACTIONS) expect(decide([grant], action, DOC, NOW)).toBe("hidden");
  });

  it("does not take away what another way in gives", () => {
    expect(can([{ kind: "link", role: "edit", revoked: true }, { kind: "user", role: "view" }], "read", DOC, NOW)).toBe(true);
    expect(can([{ kind: "link", role: "edit", revoked: true }, { kind: "user", role: "view" }], "edit", DOC, NOW)).toBe(false);
  });

  it("has an expiry of none, or null, that never comes", () => {
    expect(isLive({ kind: "link", role: "view", expiresAt: null }, NOW + 1e15)).toBe(true);
    expect(isLive({ kind: "link", role: "view" }, NOW + 1e15)).toBe(true);
  });
});

describe("holding more than one way in", () => {
  it("gives the most of them: a comment link and an edit share together may edit", () => {
    const grants: Grant[] = [{ kind: "link", role: "comment" }, { kind: "user", role: "edit" }];
    expect(effectiveRole(grants, NOW)).toBe("edit");
    expect(can(grants, "edit", DOC, NOW)).toBe(true);
    expect(can(grants, "delete", DOC, NOW)).toBe(false);
  });

  it("is hidden with none, and with a list of grants that are all dead", () => {
    expect(effectiveRole([], NOW)).toBeNull();
    expect(decide([], "read", DOC, NOW)).toBe("hidden");
    expect(decide([{ kind: "link", role: "view", revoked: true }, { kind: "link", role: "edit", expiresAt: 1 }], "read", DOC, NOW)).toBe("hidden");
  });
});

describe("what is said of a refusal", () => {
  it("is a 404 for what is hidden and a 403 for what is let in and not to this", () => {
    expect(statusOf("hidden")).toBe(404);
    expect(statusOf("forbidden")).toBe(403);
  });
});
