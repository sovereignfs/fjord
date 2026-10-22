import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { GitHubClient, parseNextLink, toProviderError } from "./http";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** A client whose fetch answers from a script, one answer per request, and records the requests. */
function scripted(answers: (Response | Error)[], retryDelaysMs?: number[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const slept: number[] = [];
  let i = 0;
  const client = new GitHubClient({
    apiUrl: "https://api.example.test/",
    token: async () => "secret-token-value",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const answer = answers[Math.min(i++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer.clone();
    }) as typeof fetch,
    sleep: async (ms) => void slept.push(ms),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
  });
  return { client, requests, slept };
}

describe("parseNextLink", () => {
  it("finds the next page among a Link header's relations", () => {
    const header = '<https://api.example.test/x?page=1>; rel="prev", <https://api.example.test/x?page=3>; rel="next", <https://api.example.test/x?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.example.test/x?page=3");
  });
  it("finds none on the last page, or without a header", () => {
    expect(parseNextLink('<https://api.example.test/x?page=1>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe("every request", () => {
  it("carries the credential, who is asking, and the API version, and renews the credential each time", async () => {
    let n = 0;
    const seen: Headers[] = [];
    const client = new GitHubClient({
      apiUrl: "https://api.example.test",
      token: async () => `token-${++n}`,
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(new Headers(init.headers));
        return json({});
      }) as typeof fetch,
    });
    await client.json("GET", "/a");
    await client.json("GET", "/b");
    expect(seen[0]!.get("authorization")).toBe("Bearer token-1");
    expect(seen[1]!.get("authorization")).toBe("Bearer token-2");
    expect(seen[0]!.get("user-agent")).toBe("fjord-web");
    expect(seen[0]!.get("x-github-api-version")).toBe("2022-11-28");
    expect(seen[0]!.get("accept")).toBe("application/vnd.github+json");
  });
});

describe("pagination", () => {
  it("follows Link: next until there is none, gathering every page", async () => {
    const { client, requests } = scripted([
      json([1, 2], { headers: { link: '<https://api.example.test/items?page=2&per_page=2>; rel="next"' } }),
      json([3, 4], { headers: { link: '<https://api.example.test/items?page=3&per_page=2>; rel="next"' } }),
      json([5]),
    ]);
    expect(await client.paginate<number>("/items", (page) => page as number[], { per_page: 2 })).toEqual([1, 2, 3, 4, 5]);
    expect(requests).toHaveLength(3);
  });

  it("stops at a hundred pages rather than follow a host that never ends", async () => {
    const never = () => json([1], { headers: { link: '<https://api.example.test/items?page=2>; rel="next"' } });
    const { client, requests } = scripted([never()]);
    await client.paginate<number>("/items", (page) => page as number[]);
    expect(requests).toHaveLength(100);
  });
});

describe("retrying", () => {
  it("retries a read after a gateway error, with a pause, and returns the answer when it comes", async () => {
    const { client, requests, slept } = scripted([json({ message: "bad gateway" }, { status: 502 }), json({ ok: true })]);
    expect((await client.json<{ ok: boolean }>("GET", "/x")).data).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(slept).toEqual([250]);
  });

  it("retries a read that failed on the network, and gives up as 'unavailable' after the last try", async () => {
    const { client, requests } = scripted([new TypeError("fetch failed")]);
    const error = await client.json("GET", "/x").catch((e: unknown) => e);
    expect(isProviderError(error, "unavailable")).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it("never retries a write: a commit whose answer was lost may have happened", async () => {
    const { client, requests } = scripted([json({ message: "bad gateway" }, { status: 502 }), json({ sha: "x" })]);
    const error = await client.json("POST", "/git/commits", { json: {} }).catch((e: unknown) => e);
    expect(isProviderError(error, "unavailable")).toBe(true);
    expect(requests).toHaveLength(1);

    const network = scripted([new TypeError("fetch failed"), json({ sha: "x" })]);
    await network.client.json("POST", "/git/commits", { json: {} }).catch(() => undefined);
    expect(network.requests).toHaveLength(1);
  });

  it("does not retry an answer that is a real answer, such as a 404 or a 401", async () => {
    for (const status of [401, 403, 404, 422]) {
      const { client, requests } = scripted([json({ message: "no" }, { status })]);
      await client.json("GET", "/x").catch(() => undefined);
      expect(requests, `status ${status}`).toHaveLength(1);
    }
  });
});

describe("what a failure says", () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => toProviderError(json(body, { status, headers }));

  it.each([
    [401, { message: "Bad credentials" }, "unauthorized"],
    [403, { message: "Resource not accessible by integration" }, "forbidden"],
    [404, { message: "Not Found" }, "not_found"],
    [409, { message: "Git Repository is empty." }, "empty_repository"],
    [409, { message: "something else" }, "invalid_request"],
    [422, { message: "Update is not a fast forward" }, "head_moved"],
    [422, { message: "Validation Failed" }, "invalid_request"],
    [500, { message: "oops" }, "unavailable"],
    [503, { message: "oops" }, "unavailable"],
    [403, { message: "too big", errors: [{ code: "too_large" }] }, "too_large"],
  ])("answers %i %j as %s", async (status, body, code) => {
    expect((await answer(status, body)).code).toBe(code);
  });

  it("tells a rate limit from a plain refusal: by the header, the message and the status", async () => {
    expect((await answer(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" })).code).toBe("rate_limited");
    expect((await answer(403, { message: "You have exceeded a secondary rate limit" })).code).toBe("rate_limited");
    expect((await answer(403, { message: "Forbidden" }, { "retry-after": "30" })).code).toBe("rate_limited");
    expect((await answer(429, { message: "slow down" })).code).toBe("rate_limited");
    expect((await answer(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "4999" })).code).toBe("forbidden");
  });

  it("says when to try again, from either header", async () => {
    const reset = await answer(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" });
    expect(reset.details.resetAt).toEqual(new Date(1893456000 * 1000));
    const after = await answer(429, { message: "slow" }, { "retry-after": "42" });
    expect(after.details.retryAfterSeconds).toBe(42);
  });

  it("keeps the request id for support, and a long message short", async () => {
    const error = await toProviderError(json({ message: "x".repeat(500) }, { status: 500, headers: { "x-github-request-id": "ABCD:1234" } }));
    expect(error.details.requestId).toBe("ABCD:1234");
    expect(error.message.length).toBeLessThanOrEqual(200);
  });

  it("copes with an answer that is not JSON", async () => {
    const error = await toProviderError(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe("GitHub answered 502");
  });

  it("never carries the credential, in any failure", async () => {
    for (const failure of [json({ message: "Bad credentials" }, { status: 401 }), new TypeError("fetch failed: secret-token-value")]) {
      const { client } = scripted([failure]);
      const error = (await client.json("GET", "/x").catch((e: unknown) => e)) as Error & { details?: unknown };
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain("secret-token-value");
    }
  });
});
