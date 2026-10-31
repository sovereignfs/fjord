import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isProviderError } from "../providers/errors";
import { InstallationTokens, appJwt } from "./tokens";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const CONFIG = { appId: "777", privateKey };
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const part = (jwt: string, index: number) => JSON.parse(Buffer.from(jwt.split(".")[index] as string, "base64url").toString("utf8")) as Record<string, unknown>;

describe("the App's own JWT", () => {
  it("is signed by the App's key, which GitHub checks with the public half", () => {
    const jwt = appJwt(CONFIG, T0);
    const [header, payload, signature] = jwt.split(".");
    expect(part(jwt, 0)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(createPublicKey(publicKey), Buffer.from(signature as string, "base64url"))).toBe(true);
  });

  it("names the App, was issued a minute ago and lasts nine minutes, under GitHub's ten", () => {
    const claims = part(appJwt(CONFIG, T0), 1);
    expect(claims).toEqual({ iss: "777", iat: T0 / 1000 - 60, exp: T0 / 1000 + 9 * 60 });
  });

  it("is not valid for another key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const [header, payload, signature] = appJwt(CONFIG, T0).split(".");
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(createPublicKey(other.publicKey), Buffer.from(signature as string, "base64url"))).toBe(false);
  });
});

function setup(answer: () => Response | Promise<Response> = () => reply("ghs_first", T0 + HOUR)) {
  let now = T0;
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => answer());
  const tokens = new InstallationTokens({ config: CONFIG, apiUrl: "https://api.example.test/", fetch: fetchMock as unknown as typeof fetch, now: () => now });
  return { tokens, fetchMock, advance: (ms: number) => (now += ms) };
}
const reply = (token: string, expiresAt: number) => new Response(JSON.stringify({ token, expires_at: new Date(expiresAt).toISOString() }), { status: 201 });

describe("an installation's token", () => {
  it("is asked for with the App's JWT, for that installation", async () => {
    const { tokens, fetchMock } = setup();
    expect(await tokens.token(42)).toBe("ghs_first");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/app/installations/42/access_tokens");
    expect(init.method).toBe("POST");
    const authorization = (init.headers as Record<string, string>).authorization as string;
    expect(authorization.startsWith("Bearer ")).toBe(true);
    expect(part(authorization.slice(7), 1).iss).toBe("777");
  });

  it("is kept until five minutes before it expires, then asked for again", async () => {
    const { tokens, fetchMock, advance } = setup();
    await tokens.token(42);
    advance(HOUR - 6 * MINUTE);
    await tokens.token(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(2 * MINUTE);
    await tokens.token(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is kept for each installation apart", async () => {
    const { tokens, fetchMock } = setup();
    await tokens.token(1);
    await tokens.token(2);
    await tokens.token(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is asked for once when many requests need it at once", async () => {
    const { tokens, fetchMock } = setup();
    const all = await Promise.all([tokens.token(42), tokens.token(42), tokens.token(42)]);
    expect(all).toEqual(["ghs_first", "ghs_first", "ghs_first"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "unauthorized"],
    [404, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [502, "unavailable"],
  ] as const)("is a %s from GitHub told as %s, and tried again next time", async (status, code) => {
    let answer: () => Response = () => new Response(JSON.stringify({ message: "ghp_secretsecret" }), { status });
    const { tokens } = setup(() => answer());
    const error = await tokens.token(42).catch((e: unknown) => e);
    expect(isProviderError(error, code)).toBe(true);
    expect(String((error as Error).message)).not.toContain("secretsecret");
    answer = () => reply("ghs_later", T0 + HOUR);
    expect(await tokens.token(42)).toBe("ghs_later");
  });

  it("is unavailable when GitHub cannot be reached, and when its answer is not a token", async () => {
    const down = new InstallationTokens({ config: CONFIG, apiUrl: "https://x.test", fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch });
    expect(isProviderError(await down.token(1).catch((e: unknown) => e), "unavailable")).toBe(true);
    const odd = setup(() => new Response(JSON.stringify({ nope: true }), { status: 201 }));
    expect(isProviderError(await odd.tokens.token(1).catch((e: unknown) => e), "unavailable")).toBe(true);
  });

  it("is never in what the App's key or the token's error says", async () => {
    const { tokens } = setup(() => new Response("", { status: 401 }));
    const error = (await tokens.token(1).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("BEGIN");
  });
});
