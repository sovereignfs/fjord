import { describe, expect, it, vi } from "vitest";
import { SHARE_COOKIE, installLogRedaction, redactTokens } from "./redact";
import { newToken } from "./tokens";

/** Share tokens never reach a log line (ROADMAP 1c.4). */
const TOKEN = newToken();
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";

describe("redacting a token", () => {
  it("finds it in an address, in a cookie and in JSON, wherever it sits in the line", () => {
    for (const line of [
      `GET /doc/${DOC}?token=${TOKEN} 200`,
      `GET https://fjord.example.com/doc/${DOC}?a=1&token=${TOKEN}&b=2`,
      `GET /doc/${DOC}?TOKEN=${TOKEN}#top`,
      `cookie: theme=dark; ${SHARE_COOKIE}=${TOKEN}; other=1`,
      `{"doc":"${DOC}","token":"${TOKEN}"}`,
      `Error: fetch failed for /doc/${DOC}?token=${TOKEN}\n    at x (y.js:1:1)`,
    ]) {
      const out = redactTokens(line);
      expect(out, line).not.toContain(TOKEN);
      expect(out, line).toContain("[redacted]");
    }
  });

  it("leaves the rest of the line as it was, and a line with no token alone", () => {
    expect(redactTokens(`GET /doc/${DOC}?token=${TOKEN}&x=1 200`)).toBe(`GET /doc/${DOC}?token=[redacted]&x=1 200`);
    expect(redactTokens(`cookie: ${SHARE_COOKIE}=${TOKEN}; a=b`)).toBe(`cookie: ${SHARE_COOKIE}=[redacted]; a=b`);
    const plain = `[fjord] database: ready; blob ${"a".repeat(40)} doc ${DOC} sha ${"B".repeat(43)}`;
    expect(redactTokens(plain)).toBe(plain);
  });

  it("finds every token in a line, not only the first", () => {
    const other = newToken();
    const out = redactTokens(`a ?token=${TOKEN} b ?token=${other}`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(other);
  });
});

describe("the console", () => {
  function fake() {
    const calls: Record<string, unknown[][]> = { log: [], info: [], warn: [], error: [], debug: [] };
    const target = Object.fromEntries(Object.keys(calls).map((name) => [name, vi.fn((...args: unknown[]) => void calls[name]!.push(args))])) as unknown as Pick<Console, "log" | "info" | "warn" | "error" | "debug">;
    return { target, calls };
  }

  it("says [redacted] for a token in anything printed, strings and errors alike, by every method", () => {
    const { target, calls } = fake();
    installLogRedaction(target);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      target[method](`GET /doc/${DOC}?token=${TOKEN}`, new Error(`failed: /doc/${DOC}?token=${TOKEN}`), { kept: "as it is" }, 7);
    }
    const printed = Object.values(calls).flat(2);
    expect(JSON.stringify(printed.map(String))).not.toContain(TOKEN);
    expect(calls.error![0]![2]).toEqual({ kept: "as it is" });
    expect(calls.error![0]![3]).toBe(7);
    expect(String(calls.error![0]![0])).toContain("[redacted]");
  });

  it("is safe to install twice: a line is redacted once and printed once", () => {
    const { target, calls } = fake();
    installLogRedaction(target);
    const once = target.log;
    installLogRedaction(target);
    expect(target.log).toBe(once); // not wrapped again
    target.log(`?token=${TOKEN}`);
    expect(calls.log).toHaveLength(1);
    expect(calls.log![0]).toEqual(["?token=[redacted]"]);
  });
});

describe("redacting a sealed share's token (ROADMAP 2c.1)", () => {
  it("finds it in the page's address and the API's, and leaves the fragment out of it, since no request carries one", () => {
    for (const line of [`GET /s/${TOKEN} 200`, `GET https://fjord.example.com/s/${TOKEN}`, `GET /api/sealed/${TOKEN} 404`, `Error: fetch failed for /api/sealed/${TOKEN}\n    at x (y.js:1:1)`]) {
      const out = redactTokens(line);
      expect(out, line).not.toContain(TOKEN);
      expect(out, line).toContain("[redacted]");
    }
    expect(redactTokens(`GET /s/${TOKEN}?x=1 200`)).toBe("GET /s/[redacted]?x=1 200");
  });

  it("leaves other addresses alone, and a path of the same length that is not a sealed share's", () => {
    expect(redactTokens(`GET /doc/${DOC} 200`)).toBe(`GET /doc/${DOC} 200`);
    expect(redactTokens(`GET /repo/1/${"A".repeat(43)} 200`)).toBe(`GET /repo/1/${"A".repeat(43)} 200`);
    expect(redactTokens("GET /s/short 200")).toBe("GET /s/short 200");
  });
});

