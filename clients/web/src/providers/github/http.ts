import { ProviderError } from "../errors";

/**
 * Talking to the GitHub REST API: one place that adds the headers, finds the credential,
 * retries what is safe to retry, follows pages, and turns what GitHub answers into a
 * `ProviderError` with a code the app can act on.
 *
 * Reads are retried a couple of times when the network or GitHub's edge fails. Writes never are:
 * a commit whose answer was lost may or may not have happened, and sending it again is how a
 * history gets a duplicate. The caller reads the head and decides.
 */
export interface GitHubClientOptions {
  /** `https://api.github.com`, or a GitHub Enterprise Server's `https://host/api/v3`. */
  apiUrl: string;
  /** Asked for on every request, so a short-lived installation token can be renewed. Never logged. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
  /** For tests: how long to wait between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits between attempts, for a read. Default: 250 ms, then 1 s. */
  retryDelaysMs?: number[];
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. */
  json?: unknown;
  /** The `Accept` header; GitHub's default is JSON. */
  accept?: string;
  /** Sent as `If-None-Match`. */
  etag?: string | undefined;
}

export interface Reply {
  status: number;
  headers: Headers;
  response: Response;
}

const API_VERSION = "2022-11-28";
const USER_AGENT = "fjord-web";

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: number[];
  private readonly base: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.delays = options.retryDelaysMs ?? [250, 1000];
    this.base = options.apiUrl.replace(/\/+$/, "");
  }

  /** A request whose answer is JSON, or nothing for a 304. */
  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; data: T | undefined; headers: Headers }> {
    const reply = await this.send(method, path, options);
    if (reply.status === 304) return { status: 304, data: undefined, headers: reply.headers };
    return { status: reply.status, data: (await reply.response.json()) as T, headers: reply.headers };
  }

  /** A request whose answer is bytes. */
  async bytes(path: string, options: RequestOptions & { maxBytes?: number | undefined } = {}): Promise<Uint8Array> {
    const reply = await this.send("GET", path, options);
    const declared = Number(reply.headers.get("content-length"));
    if (options.maxBytes !== undefined && Number.isFinite(declared) && declared > options.maxBytes) {
      discard(reply.response);
      throw new ProviderError("too_large", `the file is ${declared} bytes, over the limit of ${options.maxBytes}`);
    }
    const body = new Uint8Array(await reply.response.arrayBuffer());
    if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
      throw new ProviderError("too_large", `the file is ${body.byteLength} bytes, over the limit of ${options.maxBytes}`);
    }
    return body;
  }

  /** Every item of a paginated list, following `Link: rel="next"`. `pick` finds the items in a page. */
  async paginate<T>(path: string, pick: (page: unknown) => T[], query: Record<string, string | number | undefined> = {}): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = this.url(path, { per_page: 100, ...query });
    // A host that never stops sending `next` must not hold a request for ever.
    for (let pages = 0; next && pages < 100; pages++) {
      const reply = await this.send("GET", next, {});
      items.push(...pick(await reply.response.json()));
      next = parseNextLink(reply.headers.get("link"));
    }
    return items;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async send(method: string, path: string, options: RequestOptions): Promise<Reply> {
    const readonly = method === "GET";
    const url = path.startsWith("http") ? path : this.url(path, options.query);
    const attempts = readonly ? this.delays.length + 1 : 1;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            accept: options.accept ?? "application/vnd.github+json",
            authorization: `Bearer ${await this.options.token()}`,
            "user-agent": USER_AGENT,
            "x-github-api-version": API_VERSION,
            ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
            ...(options.etag ? { "if-none-match": options.etag } : {}),
          },
          ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
        });
      } catch (error) {
        // The network failed before an answer came. Never put the credential in what is thrown.
        if (attempt + 1 < attempts) {
          await this.sleep(this.delays[attempt] ?? 1000);
          continue;
        }
        throw new ProviderError("unavailable", `could not reach GitHub (${error instanceof Error ? error.name : "network error"})`);
      }

      if (response.ok || response.status === 304) return { status: response.status, headers: response.headers, response };

      // A server-side failure of a read is worth another try; anything else is an answer.
      if (readonly && [502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        discard(response);
        await this.sleep(this.delays[attempt] ?? 1000);
        continue;
      }
      throw await toProviderError(response);
    }
  }
}

/**
 * Let go of an answer that will not be read, so its connection can be reused. Not awaited: a
 * body that is slow to cancel is no reason to hold up what happens next.
 */
function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** The URL of the next page from a `Link` header, if there is one. */
export function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

/** GitHub's error answers, as the app's codes. */
export async function toProviderError(response: Response): Promise<ProviderError> {
  const body = await response.json().catch(() => undefined) as { message?: string; errors?: { code?: string; message?: string }[] } | undefined;
  const message = body?.message?.slice(0, 200) || `GitHub answered ${response.status}`;
  const requestId = response.headers.get("x-github-request-id") ?? undefined;
  const details = { status: response.status, ...(requestId ? { requestId } : {}) };

  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(response.headers.get("retry-after"));
  const limited =
    response.status === 429 ||
    (response.status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && retryAfter > 0 || /rate limit|abuse/i.test(message)));
  if (limited) {
    return new ProviderError("rate_limited", message, {
      ...details,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      ...(Number.isFinite(reset) && reset > 0 ? { resetAt: new Date(reset * 1000) } : {}),
    });
  }
  if (body?.errors?.some((e) => e.code === "too_large")) return new ProviderError("too_large", message, details);

  switch (response.status) {
    case 401:
      return new ProviderError("unauthorized", message, details);
    case 403:
      return new ProviderError("forbidden", message, details);
    case 404:
      return new ProviderError("not_found", message, details);
    case 409:
      return new ProviderError(/empty/i.test(message) ? "empty_repository" : "invalid_request", message, details);
    case 422:
      // A ref update that is not a fast-forward is the host saying the head has moved.
      return new ProviderError(/fast forward|fast-forward/i.test(message) ? "head_moved" : "invalid_request", message, details);
    default:
      return new ProviderError(response.status >= 500 ? "unavailable" : "invalid_request", message, details);
  }
}
