import { isDocId } from "../browse/ids";
import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import { shareCookieOf } from "../sharing/guest-http";
import type { Caller } from "./http";

/**
 * Live updates (`GET /doc/<id>/comments/events`, DESIGN.md §13, ROADMAP 1d.3): a server-sent stream that says *that* a document's comments changed,
 * and never what they are. The page, told so, reads them again through the ordinary route, which checks who is asking every time; so the stream
 * carries nothing a person who lost access could learn but a number going up.
 *
 *  - **Who may watch** is who may read the comments (the policy's `read`), checked when the stream opens and again every so often while it is
 *    open: when it no longer holds (a link revoked or expired, a share ended) the stream says `gone` and ends.
 *  - **What it says:** `version` at the start (where the comments are up to, so that a change made between the page's reading them and its
 *    listening is seen), `changed` with the new number whenever it moves, `gone` once, and a comment line every so often so that nothing in between
 *    closes an idle connection. A stream ends by itself after a while; the browser opens it again, which checks again.
 *  - **How it knows:** in this process at once (`bus.ts`), and from the database, which is how another process's change arrives, a few seconds later.
 *  - **How many:** a process holds at most `MAX_STREAMS`; one more is told to try later, so that open pages cannot hold the server's memory.
 */
export interface Watch {
  /** Who is watching, for the limit on how many streams one holder may have: `account:<id>` or `link:<id>`. */
  holder: string;
  /** Where the document's comments are up to. */
  version: () => Promise<number>;
  /** Whether the watcher may still read them. */
  allowed: () => Promise<boolean>;
  /** Be told at once of a change made in this process; returns how to stop. */
  subscribe: (listener: () => void) => () => void;
}

export interface EventDeps {
  open: (input: { docId: string; account: { id: string; name: string } | undefined; cookie: string | undefined }) => Promise<{ ok: true; watch: Watch } | { ok: false; reason: "hidden" | "forbidden" }>;
  /** How often the database is asked, how often who is watching is checked again, how long a stream lasts, and how long it may be silent. */
  pollMs?: number;
  recheckMs?: number;
  lifetimeMs?: number;
  quietMs?: number;
}

export const MAX_STREAMS = 300;
/** One account's tabs, and one link's readers, may hold no more than this many of the process's streams (ROADMAP 1d.4). */
export const MAX_STREAMS_PER_ACCOUNT = 20;
export const MAX_STREAMS_PER_LINK = 100;
let open = 0;
const held = new Map<string, number>();
const limitOf = (holder: string) => (holder.startsWith("account:") ? MAX_STREAMS_PER_ACCOUNT : MAX_STREAMS_PER_LINK);
/** How many streams are open in this process, for tests. */
export const streamsOpen = () => open;

const POLL_MS = 4_000;
const RECHECK_MS = 15_000;
const LIFETIME_MS = 5 * 60_000;
const QUIET_MS = 20_000;

const HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  // `no-transform` so that nothing between here and the browser compresses the stream and holds it back to do so.
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
  "referrer-policy": "no-referrer",
};

function plain(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra } });
}

export async function handleEvents(request: Request, caller: Caller | null, deps: EventDeps, docId: string): Promise<Response> {
  if (request.method !== "GET") return plain(405, "method_not_allowed", "That method is not allowed here.");
  if (!isDocId(docId)) return plain(404, "not_found", "There is no such document.");
  if (open >= MAX_STREAMS) return plain(503, "busy", "Too many pages are watching just now. Comments still load; try again in a moment.", { "retry-after": "30" });

  let opened;
  try {
    opened = await deps.open({ docId, account: caller ? { id: caller.accountId, name: caller.name } : undefined, cookie: shareCookieOf(request.headers.get("cookie")) });
  } catch (error) {
    if (isCredentialError(error, "no_key")) return plain(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
    if (isProviderError(error, "rate_limited")) return plain(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
    console.error(`[fjord] comment events: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return plain(500, "internal_error", "Something went wrong on our side. Try again.");
  }
  if (!opened.ok) return opened.reason === "hidden" ? plain(404, "not_found", "There is no such document.") : plain(403, "forbidden", "You may not watch this document's comments.");
  const { watch } = opened;
  if ((held.get(watch.holder) ?? 0) >= limitOf(watch.holder)) return plain(429, "too_many_streams", "This is open in too many places at once. Close some, or reload this page.", { "retry-after": "30" });

  const pollMs = deps.pollMs ?? POLL_MS;
  const recheckMs = deps.recheckMs ?? RECHECK_MS;
  const lifetimeMs = deps.lifetimeMs ?? LIFETIME_MS;
  const quietMs = deps.quietMs ?? QUIET_MS;
  const encoder = new TextEncoder();
  open++;
  held.set(watch.holder, (held.get(watch.holder) ?? 0) + 1);
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let last: number | undefined;
      let lastSent = Date.now();
      let lastChecked = Date.now();
      const startedAt = Date.now();
      let working = false;
      let again = false;
      const timers: ReturnType<typeof setInterval>[] = [];
      let unsubscribe = () => {};

      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
          lastSent = Date.now();
        } catch {
          finish();
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearInterval(timer);
        unsubscribe();
        request.signal.removeEventListener("abort", finish);
        open--;
        const rest = (held.get(watch.holder) ?? 1) - 1;
        if (rest <= 0) held.delete(watch.holder);
        else held.set(watch.holder, rest);
        try {
          controller.close();
        } catch {
          // Already closed by the browser going away.
        }
      };
      cleanup = finish;

      /** Look: still allowed, and has it moved? One look at a time; a change that arrives during one is looked for again after. */
      const look = async (force = false) => {
        if (closed) return;
        if (working) {
          again = true;
          return;
        }
        working = true;
        try {
          do {
            again = false;
            if (force || Date.now() - lastChecked >= recheckMs) {
              lastChecked = Date.now();
              if (!(await watch.allowed())) {
                send("event: gone\ndata: {}\n\n");
                return finish();
              }
            }
            const version = await watch.version();
            if (last === undefined) send(`event: version\ndata: ${JSON.stringify({ version })}\n\n`);
            else if (version !== last) send(`event: changed\ndata: ${JSON.stringify({ version })}\n\n`);
            last = version;
          } while (again && !closed);
        } catch {
          // Whatever went wrong, the browser opens a new stream (which checks everything again) and reads the comments in the meantime.
          finish();
        } finally {
          working = false;
        }
      };

      request.signal.addEventListener("abort", finish);
      if (request.signal.aborted) return finish();
      send("retry: 5000\n\n");
      unsubscribe = watch.subscribe(() => void look());
      await look(false);
      timers.push(
        setInterval(() => {
          if (Date.now() - startedAt >= lifetimeMs) return finish();
          void look();
          if (Date.now() - lastSent >= quietMs) send(": still here\n\n");
        }, pollMs),
      );
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { status: 200, headers: HEADERS });
}
