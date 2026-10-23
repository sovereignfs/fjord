import { describe, expect, it } from "vitest";
import { ConfigError } from "../db/config";
import { GITHUB_API_URL, resolveGitHubApiUrl } from "./config";

describe("resolveGitHubApiUrl", () => {
  it("is GitHub's when nothing is set", () => {
    expect(resolveGitHubApiUrl({})).toBe(GITHUB_API_URL);
    expect(resolveGitHubApiUrl({ FJORD_GITHUB_API_URL: "  " })).toBe(GITHUB_API_URL);
  });

  it("takes an Enterprise Server's, without a trailing slash", () => {
    expect(resolveGitHubApiUrl({ FJORD_GITHUB_API_URL: "https://github.example.com/api/v3/" })).toBe("https://github.example.com/api/v3");
  });

  it("allows plain http on localhost only, since tokens are sent there", () => {
    expect(resolveGitHubApiUrl({ FJORD_GITHUB_API_URL: "http://localhost:3192" })).toBe("http://localhost:3192");
    expect(() => resolveGitHubApiUrl({ FJORD_GITHUB_API_URL: "http://github.example.com/api/v3" })).toThrow(/https/);
  });

  it("refuses what is not a URL, and a query, a fragment or credentials in one", () => {
    for (const bad of ["nope", "https://github.example.com/api/v3?x=1", "https://github.example.com/api#x", "https://user:pw@github.example.com/api/v3"]) {
      expect(() => resolveGitHubApiUrl({ FJORD_GITHUB_API_URL: bad })).toThrow(ConfigError);
    }
  });
});
