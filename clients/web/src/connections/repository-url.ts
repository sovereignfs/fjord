import { ConnectionError } from "./errors";
import type { RepositoryRef } from "../providers/types";

/**
 * The repository a person means by what they typed or pasted: `https://github.com/owner/repo`
 * (with or without `.git`, a trailing slash, or `www.`), `github.com/owner/repo`,
 * `git@github.com:owner/repo.git`, or just `owner/repo`. Anything else is refused with a reason
 * and not guessed at: an address on another host, a page inside a repository, an address with
 * credentials in it (which would be a token pasted in the wrong box, and is not echoed).
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const HELP = "Use an address like https://github.com/owner/repository, or owner/repository.";

export function parseRepository(input: string): RepositoryRef {
  const text = input.trim();
  if (text === "") throw new ConnectionError("invalid_repository", `Enter the repository's address. ${HELP}`);

  let path: string;
  const scp = /^git@([^:]+):(.+)$/.exec(text);
  if (scp) {
    requireGitHub(scp[1]!);
    path = scp[2]!;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new ConnectionError("invalid_repository", `That is not an address we can read. ${HELP}`);
    }
    if (url.username || url.password) {
      throw new ConnectionError("invalid_repository", "That address has a username or password in it. Enter the plain repository address, and the token in its own box.");
    }
    if (url.protocol !== "https:") throw new ConnectionError("invalid_repository", `Use an https address. ${HELP}`);
    requireGitHub(url.hostname);
    path = url.pathname;
  } else if (/^(www\.)?github\.com\//i.test(text)) {
    path = text.replace(/^(www\.)?github\.com\//i, "");
  } else if (/^[^/\s]+\/[^/\s]+$/.test(text) && !text.includes(".com")) {
    path = text;
  } else if (/^[^/\s]+\.[a-z]{2,}\//i.test(text)) {
    throw new ConnectionError("unsupported_host", "Only GitHub repositories can be connected so far.");
  } else {
    throw new ConnectionError("invalid_repository", `That does not look like a repository. ${HELP}`);
  }

  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) {
    throw new ConnectionError("invalid_repository", `The address should be of the repository itself, not a page inside it. ${HELP}`);
  }
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new ConnectionError("invalid_repository", `That is not a valid GitHub owner and repository name. ${HELP}`);
  }
  return { owner, name };
}

function requireGitHub(host: string): void {
  if (!/^(www\.)?github\.com$/i.test(host)) throw new ConnectionError("unsupported_host", "Only GitHub repositories can be connected so far.");
}
