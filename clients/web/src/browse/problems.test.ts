import { describe, expect, it } from "vitest";
import { CredentialError } from "../crypto/errors";
import { FormatUnavailableError } from "../format/wasm";
import { ProviderError } from "../providers/errors";
import { describeProblem } from "./problems";

const TOKEN = "github_pat_secrettoken0123456789abcdefghijklmnopqrstuv";

describe("describeProblem", () => {
  it.each([
    ["unauthorized", /no longer accepts/],
    ["forbidden", /would not let this token/],
    ["not_found", /cannot find this repository/],
    ["empty_repository", /empty/],
    ["rate_limited", /limiting requests/],
    ["unavailable", /Could not reach/],
  ] as const)("explains a host's %s", (code, message) => {
    const problem = describeProblem(new ProviderError(code, `GitHub said: Bad credentials for ${TOKEN}`));
    expect(problem).toMatchObject({ code });
    expect(problem!.message).toMatch(message);
    // Neither the host's text nor a token ever reaches a page.
    expect(problem!.message).not.toContain(TOKEN);
    expect(problem!.message).not.toContain("Bad credentials");
  });

  it("explains a credential this instance cannot open, and a module that is not built", () => {
    expect(describeProblem(new CredentialError("corrupt", "x"))).toMatchObject({ code: "credential" });
    expect(describeProblem(new CredentialError("unknown_key", "x"))).toMatchObject({ code: "credential" });
    const setup = describeProblem(new FormatUnavailableError("not built at /somewhere"));
    expect(setup).toMatchObject({ code: "setup" });
    expect(setup!.message).not.toContain("/somewhere");
  });

  it("leaves what is nobody's to explain, so a bug surfaces as one", () => {
    expect(describeProblem(new Error("boom"))).toBeUndefined();
    expect(describeProblem(new ProviderError("invalid_request", "x"))).toBeUndefined();
    expect(describeProblem(new CredentialError("no_key", "x"))).toBeUndefined();
    expect(describeProblem("a string")).toBeUndefined();
  });
});
