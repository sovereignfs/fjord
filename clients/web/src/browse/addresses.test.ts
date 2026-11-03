import { describe, expect, it } from "vitest";
import { noteAddress, parseAddress, placeAddress, repositoryAddress, vaultAddress } from "./addresses";

/** The addresses of a repository's places (workstream 0003): each shape, written out from the design and not from the code. */
const VAULT = "01jagc4k7pr9tbm3ykwx6zq2hv";
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const FOLDER = "0123456789abcdef";
const FILE = "fedcba9876543210";

describe("parsing an address", () => {
  it("knows each place", () => {
    expect(parseAddress([])).toEqual({ kind: "repository" });
    expect(parseAddress(["v", VAULT])).toEqual({ kind: "vault", vault: VAULT });
    expect(parseAddress(["v", VAULT, FILE])).toEqual({ kind: "place", vault: VAULT, parent: undefined, target: { handle: FILE } });
    expect(parseAddress(["v", VAULT, FOLDER])).toEqual({ kind: "place", vault: VAULT, parent: undefined, target: { handle: FOLDER } });
    expect(parseAddress(["v", VAULT, FOLDER, FILE])).toEqual({ kind: "place", vault: VAULT, parent: FOLDER, target: { handle: FILE } });
    expect(parseAddress(["v", VAULT, "d", DOC])).toEqual({ kind: "place", vault: VAULT, parent: undefined, target: { doc: DOC } });
    expect(parseAddress(["v", VAULT, FOLDER, "d", DOC])).toEqual({ kind: "place", vault: VAULT, parent: FOLDER, target: { doc: DOC } });
  });

  it("knows a static HTML page, with or without its folder", () => {
    expect(parseAddress(["v", VAULT, "html", FILE])).toEqual({ kind: "place", vault: VAULT, parent: undefined, target: { html: FILE } });
    expect(parseAddress(["v", VAULT, FOLDER, "html", FILE])).toEqual({ kind: "place", vault: VAULT, parent: FOLDER, target: { html: FILE } });
    expect(parseAddress(["v", VAULT, "html", "x"]).kind).toBe("invalid");
    expect(placeAddress(7, VAULT, { html: FILE }, FOLDER)).toBe(`/repo/7/v/${VAULT}/${FOLDER}/html/${FILE}`);
  });

  it("knows a journal's note by its id or, with none, its handle, and takes n with anything else for the old form", () => {
    expect(parseAddress(["n", DOC])).toEqual({ kind: "note", target: { doc: DOC } });
    expect(parseAddress(["n", FILE])).toEqual({ kind: "note", target: { handle: FILE } });
    expect(parseAddress(["n", "plan.md"])).toEqual({ kind: "legacy", segments: ["n", "plan.md"] });
    expect(parseAddress(["n"])).toEqual({ kind: "legacy", segments: ["n"] });
    expect(noteAddress(7, { doc: DOC })).toBe(`/repo/7/n/${DOC}`);
    expect(noteAddress(7, { handle: FILE })).toBe(`/repo/7/n/${FILE}`);
  });

  it("is what the builders make, for every shape", () => {
    const rest = (address: string) => address.slice("/repo/7/".length).split("/");
    expect(parseAddress(rest(vaultAddress(7, VAULT)))).toEqual({ kind: "vault", vault: VAULT });
    expect(parseAddress(rest(placeAddress(7, VAULT, { handle: FILE })))).toMatchObject({ kind: "place", target: { handle: FILE } });
    expect(parseAddress(rest(placeAddress(7, VAULT, { handle: FILE }, FOLDER)))).toMatchObject({ kind: "place", parent: FOLDER, target: { handle: FILE } });
    expect(parseAddress(rest(placeAddress(7, VAULT, { doc: DOC })))).toMatchObject({ kind: "place", target: { doc: DOC } });
    expect(parseAddress(rest(placeAddress(7, VAULT, { doc: DOC }, FOLDER)))).toMatchObject({ kind: "place", parent: FOLDER, target: { doc: DOC } });
    expect(placeAddress(7, VAULT, { doc: DOC }, FOLDER)).toBe(`/repo/7/v/${VAULT}/${FOLDER}/d/${DOC}`);
    expect(placeAddress(7, VAULT, { handle: FILE })).toBe(`/repo/7/v/${VAULT}/${FILE}`);
  });

  it("takes anything that is not of this shape for the old form with a path, so a vault named v, or a folder named d, is not mistaken", () => {
    expect(parseAddress(["Public", "Q4", "report.fj.md"])).toEqual({ kind: "legacy", segments: ["Public", "Q4", "report.fj.md"] });
    expect(parseAddress(["v", "notes"])).toEqual({ kind: "legacy", segments: ["v", "notes"] });
    expect(parseAddress(["v"])).toEqual({ kind: "legacy", segments: ["v"] });
    expect(parseAddress(["d", DOC])).toEqual({ kind: "legacy", segments: ["d", DOC] });
  });

  it("refuses what is of the shape and is not made of ids: a path inside a vault's address, a chain of folders, an id of the wrong length", () => {
    expect(parseAddress(["v", VAULT, "Q4"]).kind).toBe("invalid");
    expect(parseAddress(["v", VAULT, "Q4", "report.md"]).kind).toBe("invalid");
    expect(parseAddress(["v", VAULT, FOLDER, FOLDER, FILE]).kind).toBe("invalid");
    expect(parseAddress(["v", VAULT, "d", "short"]).kind).toBe("invalid");
    expect(parseAddress(["v", VAULT, "x", "d", DOC]).kind).toBe("invalid");
    expect(parseAddress(["v", VAULT, FOLDER, "d", DOC, "more"]).kind).toBe("invalid");
  });
});
