import { ConfigError, type Env } from "../db/config";

/**
 * Where GitHub's API is. `FJORD_GITHUB_API_URL` is optional and says so only when it is not
 * github.com's: a GitHub Enterprise Server's (`https://github.example.com/api/v3`), or, in the
 * browser tests, a stand-in on localhost. It is where tokens are sent, so it must be https,
 * except on localhost.
 */
export const GITHUB_API_URL = "https://api.github.com";

export function resolveGitHubApiUrl(env: Env = process.env): string {
  const value = (env.FJORD_GITHUB_API_URL ?? "").trim();
  if (value === "") return GITHUB_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("FJORD_GITHUB_API_URL is not a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError("FJORD_GITHUB_API_URL must be https, except on localhost: access tokens are sent there.");
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new ConfigError("FJORD_GITHUB_API_URL must have no query, fragment or credentials.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
