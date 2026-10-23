import { describe, expect, it } from "vitest";
import { isConnectionError } from "./errors";
import { parseRepository } from "./repository-url";

const ref = { owner: "acme", name: "notes" };

describe("parseRepository", () => {
  it.each([
    "https://github.com/acme/notes",
    "https://github.com/acme/notes/",
    "https://github.com/acme/notes.git",
    "https://www.github.com/acme/notes",
    "HTTPS://GitHub.com/acme/notes",
    "github.com/acme/notes",
    "www.github.com/acme/notes.git",
    "git@github.com:acme/notes.git",
    "git@github.com:acme/notes",
    "acme/notes",
    "  acme/notes  ",
  ])("reads %s", (text) => {
    expect(parseRepository(text)).toEqual(ref);
  });

  it("keeps the case and the dots, dashes and underscores a name may have", () => {
    expect(parseRepository("Some-Org/my_repo.v2")).toEqual({ owner: "Some-Org", name: "my_repo.v2" });
    expect(parseRepository("a/b.github.io")).toEqual({ owner: "a", name: "b.github.io" });
  });

  const refused: [string, string, RegExp][] = [
    ["", "invalid_repository", /Enter the repository/],
    ["   ", "invalid_repository", /Enter the repository/],
    ["https://gitlab.com/acme/notes", "unsupported_host", /Only GitHub/],
    ["git@gitlab.com:acme/notes.git", "unsupported_host", /Only GitHub/],
    ["gitlab.com/acme/notes", "unsupported_host", /Only GitHub/],
    ["http://github.com/acme/notes", "invalid_repository", /https/],
    ["https://github.com/acme/notes/tree/main/docs", "invalid_repository", /repository itself/],
    ["https://github.com/acme", "invalid_repository", /repository itself/],
    ["https://github.com/", "invalid_repository", /repository itself/],
    ["https://github.com/acme/notes/issues", "invalid_repository", /repository itself/],
    ["acme", "invalid_repository", /does not look like a repository/],
    ["acme/notes/extra", "invalid_repository", /does not look like a repository/],
    ["https://github.com/-bad-/notes", "invalid_repository", /valid GitHub owner/],
    // A URL parser resolves `..` itself, so this reads as the owner's page; the shorthand is checked below.
    ["https://github.com/acme/..", "invalid_repository", /repository itself/],
    ["acme/..", "invalid_repository", /valid GitHub owner/],
    ["https://github.com/acme/no tes", "invalid_repository", /./],
    ["not a url at all", "invalid_repository", /./],
    ["ftp://github.com/acme/notes", "invalid_repository", /https/],
  ];
  it.each(refused)("refuses %j", (text, code, message) => {
    let error: unknown;
    try {
      parseRepository(text);
    } catch (e) {
      error = e;
    }
    expect(isConnectionError(error, code as never)).toBe(true);
    expect((error as Error).message).toMatch(message);
  });

  it("refuses an address with a password in it, and does not repeat it", () => {
    const text = "https://acme:ghp_SecretToken123@github.com/acme/notes";
    let message = "";
    try {
      parseRepository(text);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/username or password/);
    expect(message).not.toContain("ghp_SecretToken123");
  });
});
