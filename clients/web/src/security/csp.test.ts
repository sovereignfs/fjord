import { describe, expect, it } from "vitest";
import { HSTS, LIBRARY_STYLE_HASHES, SECURITY_HEADERS, contentSecurityPolicy, newNonce } from "./csp";

/** What the Content-Security-Policy allows and refuses (DESIGN.md §15, ROADMAP 1d.5): each directive, written out from the design and not from the code. */
const policy = (over: Partial<Parameters<typeof contentSecurityPolicy>[0]> = {}) => contentSecurityPolicy({ nonce: "NONCE123", secure: true, development: false, ...over });
const directive = (text: string, name: string) => text.split("; ").find((part) => part === name || part.startsWith(`${name} `));

describe("scripts", () => {
  it("run only with the request's nonce, or when a script with it loads them: no inline script, no inline handler, no javascript: address, no eval", () => {
    const script = directive(policy(), "script-src")!;
    expect(script).toBe("script-src 'self' 'nonce-NONCE123' 'strict-dynamic'");
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it("may use eval in development only, where React asks for it", () => {
    expect(directive(policy({ development: true }), "script-src")).toContain("'unsafe-eval'");
    expect(policy()).not.toContain("unsafe-eval");
  });
});

describe("styles", () => {
  it("have their elements marked with the nonce, and their attributes allowed, because the document editor and server-rendered style props need them", () => {
    expect(directive(policy(), "style-src-elem")).toBe(`style-src-elem 'self' 'nonce-NONCE123' ${LIBRARY_STYLE_HASHES.map((hash) => `'${hash}'`).join(" ")}`);
    expect(directive(policy(), "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    expect(directive(policy(), "style-src")).toMatch(/^style-src 'self' 'nonce-NONCE123' 'sha256-/);
  });
});

describe("the styles libraries make", () => {
  it("are allowed by their hash and nothing else without the nonce: a handful of fixed strings, each a sha256", () => {
    expect(LIBRARY_STYLE_HASHES.length).toBeGreaterThan(0);
    for (const hash of LIBRARY_STYLE_HASHES) expect(hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    expect(policy()).not.toMatch(/style-src(-elem)? [^;]*unsafe-inline/);
  });
});

describe("what loads from where", () => {
  it("is this origin's own, for images (and the editor's data: and blob:), fonts and requests: nothing third-party", () => {
    const text = policy();
    expect(directive(text, "default-src")).toBe("default-src 'self'");
    expect(directive(text, "img-src")).toBe("img-src 'self' data: blob:");
    expect(directive(text, "font-src")).toBe("font-src 'self'");
    expect(directive(text, "connect-src")).toBe("connect-src 'self'");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("allows no frames, no plugins, no framing of a page, no other base address, and forms only to here", () => {
    const text = policy();
    for (const exact of ["frame-src 'none'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) expect(directive(text, exact.split(" ")[0]!), exact).toBe(exact);
  });
});

describe("upgrading requests", () => {
  it("is asked for over https, and not over http, where it would send the page's own requests to a port that does not speak https", () => {
    expect(policy({ secure: true })).toContain("upgrade-insecure-requests");
    expect(policy({ secure: false })).not.toContain("upgrade-insecure-requests");
  });
});

describe("the nonce", () => {
  it("is 128 bits of base64, new every time, and is the only thing in the policy that changes", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => newNonce()));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const bare = (text: string) => text.replace(/nonce-[^']+/g, "nonce-N");
    expect(bare(policy({ nonce: "AAAA" }))).toBe(bare(policy({ nonce: "BBBB" })));
  });
});

describe("the other headers", () => {
  it("stop sniffing, framing, device access and another site's window, and say https only over https", () => {
    const headers = Object.fromEntries(SECURITY_HEADERS.map((header) => [header.key, header.value]));
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Permissions-Policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(HSTS).toMatch(/^max-age=\d{8,}/);
  });
});
