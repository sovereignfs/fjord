import { isCredentialError } from "../crypto/errors";
import { FormatUnavailableError } from "../format/wasm";
import { isProviderError } from "../providers/errors";

/**
 * Why a repository could not be shown, in words for the person looking, or `undefined` for a failure that is
 * nobody's to explain (a bug), which is left to surface as one. No message carries a token, and none carries the
 * host's own text.
 */
export interface Problem {
  /** For a test, and for a page that does something different for one. */
  code: "unauthorized" | "not_found" | "forbidden" | "empty_repository" | "rate_limited" | "unavailable" | "credential" | "setup";
  message: string;
}

export function describeProblem(error: unknown): Problem | undefined {
  if (isProviderError(error)) {
    switch (error.code) {
      case "unauthorized":
        return { code: "unauthorized", message: "GitHub no longer accepts this repository's token: it may have expired or been revoked. Disconnect the repository and connect it again with a new token." };
      case "forbidden":
        return { code: "forbidden", message: "GitHub would not let this token read the repository. If it belongs to an organisation, the token may need the organisation's approval." };
      case "not_found":
        return { code: "not_found", message: "GitHub cannot find this repository or its branch any more. It may have been renamed, deleted or had access removed. Disconnect it and connect it again if it has moved." };
      case "empty_repository":
        return { code: "empty_repository", message: "This repository is empty: there is nothing in it to show yet." };
      case "rate_limited":
        return { code: "rate_limited", message: "GitHub is limiting requests right now. Try again in a minute." };
      case "unavailable":
        return { code: "unavailable", message: "Could not reach GitHub. Try again in a moment." };
      default:
        return undefined;
    }
  }
  if (isCredentialError(error, "corrupt") || isCredentialError(error, "unknown_key")) {
    return { code: "credential", message: "This repository's token cannot be read by this instance (its encryption key may have changed). Disconnect the repository and connect it again." };
  }
  if (error instanceof FormatUnavailableError) {
    return { code: "setup", message: "This instance cannot read repositories yet: the Fjord format module is not set up. Whoever runs it needs to build it (pnpm build:wasm) or set FJORD_WASM_DIR." };
  }
  return undefined;
}
