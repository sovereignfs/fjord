import { describe, expect, it } from "vitest";
import type { Viewer } from "./access";
import { REANCHOR_RATE, reanchorRates, writeRates } from "./rates";

/** What a comment write is counted against (ROADMAP 1d.4): the numbers are written out here, from DESIGN.md §13, and not from the code. */
const ALICE = { id: "alice", name: "Alice" };
const owner: Viewer = { connectionId: 1, grants: [{ kind: "owner" }], account: ALICE };
const viaLink: Viewer = { connectionId: 1, grants: [{ kind: "link", role: "comment", expiresAt: null, revoked: false }], linkId: 3 };
const asAccountViaLink: Viewer = { ...viaLink, account: ALICE };
const rulesOf = (entries: { key: string; rule: { limit: number; windowMs: number } }[]) => entries.map((entry) => [entry.key, entry.rule.limit, entry.rule.windowMs]);

describe("how fast comments may be written", () => {
  it("is, for an account, 30 a minute and 600 an hour of its own", () => {
    expect(rulesOf(writeRates(owner, { kind: "account", id: "alice", name: "Alice" }))).toEqual([
      ["comment:account:alice:60000", 30, 60_000],
      ["comment:account:alice:3600000", 600, 3_600_000],
    ]);
  });

  it("is, for a guest, 20 a minute and 200 an hour of their browser's, and the link's 60 and 600 for all of its guests together", () => {
    expect(rulesOf(writeRates(viaLink, { kind: "guest", id: "3:browser-1", name: "Grace" }))).toEqual([
      ["comment:guest:3:browser-1:60000", 20, 60_000],
      ["comment:guest:3:browser-1:3600000", 200, 3_600_000],
      ["comment:link:3:60000", 60, 60_000],
      ["comment:link:3:3600000", 600, 3_600_000],
    ]);
  });

  it("counts an account that came in by a link against the link too, and as the account", () => {
    const keys = writeRates(asAccountViaLink, { kind: "account", id: "alice", name: "Alice" }).map((entry) => entry.key);
    expect(keys).toEqual(["comment:account:alice:60000", "comment:account:alice:3600000", "comment:link:3:60000", "comment:link:3:3600000"]);
  });

  it("gives two guests of one link the one link's count, and two links their own", () => {
    const one = writeRates(viaLink, { kind: "guest", id: "3:a-browser-1", name: "A" }).map((entry) => entry.key);
    const two = writeRates(viaLink, { kind: "guest", id: "3:b-browser-2", name: "B" }).map((entry) => entry.key);
    expect(one.filter((key) => two.includes(key))).toEqual(["comment:link:3:60000", "comment:link:3:3600000"]);
    expect(writeRates({ ...viaLink, linkId: 4 }, { kind: "guest", id: "4:a-browser-1", name: "A" }).map((entry) => entry.key)).not.toContain("comment:link:3:60000");
  });

  it("moves threads onto edited words at most 120 a minute, by account or else by link", () => {
    expect(REANCHOR_RATE).toEqual({ limit: 120, windowMs: 60_000 });
    expect(reanchorRates(owner).map((entry) => entry.key)).toEqual(["comment:reanchor:account:alice"]);
    expect(reanchorRates(viaLink).map((entry) => entry.key)).toEqual(["comment:reanchor:link:3"]);
  });
});
