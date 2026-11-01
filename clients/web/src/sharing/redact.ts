/**
 * Share tokens are kept out of logs (DESIGN.md §12, ROADMAP 1c.4). A link's address carries its token, and an address is the
 * kind of thing that gets logged: in an error message, in a stack, by a library that prints the URL it was asked for. So
 * anything that can be printed is first made to say `[redacted]` where a token was: the `token=` of an address, the share
 * cookie's value, and a `"token"` of JSON. The app itself never logs a token or a whole address (an unexpected failure is logged by
 * its name alone); this is for what it does not control. Only what is *marked* as a token is found: a bare string of the same
 * length is not touched, since a hash or an id looks the same and is no secret.
 */
export const SHARE_COOKIE = "fjord_share";
/** The cookie that holds a password link's token while its password is asked for (ROADMAP 1c.5). */
export const PENDING_COOKIE = "fjord_share_pending";

const PATTERNS: [RegExp, string][] = [
  [/([?&]token=)[^&\s"'#<>]+/gi, "$1[redacted]"],
  [new RegExp(`((?:${SHARE_COOKIE}|${PENDING_COOKIE})=)[^;\\s"'<>]+`, "g"), "$1[redacted]"],
  [/("token"\s*:\s*")[^"]+/gi, "$1[redacted]"],
  // A sealed share's address carries its token in the path (ROADMAP 2c.1): `/s/<token>`, `/api/sealed/<token>`. Its key is in the fragment, which no request carries and so no log can.
  [/(\/(?:s|api\/sealed)\/)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "$1[redacted]"],
];

export function redactTokens(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

type Writer = (...args: unknown[]) => void;
const METHODS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * Make the console say `[redacted]` for a token wherever one is printed: strings are redacted, and an error is printed as its
 * redacted stack (or message). Other values (objects) are passed on as they are. Safe to call twice.
 */
export function installLogRedaction(target: Pick<Console, (typeof METHODS)[number]> = console): void {
  for (const method of METHODS) {
    const original = target[method] as Writer & { redacting?: true };
    if (original.redacting) continue;
    const wrapped: Writer & { redacting?: true } = (...args) =>
      original.apply(target, args.map((arg) => (typeof arg === "string" ? redactTokens(arg) : arg instanceof Error ? redactTokens(arg.stack ?? `${arg.name}: ${arg.message}`) : arg)));
    wrapped.redacting = true;
    target[method] = wrapped as Console[typeof method];
  }
}
