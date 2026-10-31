import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../db/config";
import { githubAppConfig, githubWebUrl } from "./config";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const FULL = {
  FJORD_GITHUB_APP_ID: "12345",
  FJORD_GITHUB_APP_SLUG: "my-fjord",
  FJORD_GITHUB_APP_PRIVATE_KEY: privateKey,
  FJORD_GITHUB_APP_CLIENT_ID: "Iv1.abc",
  FJORD_GITHUB_APP_CLIENT_SECRET: "client-secret",
  FJORD_GITHUB_APP_WEBHOOK_SECRET: "a-webhook-secret-of-length",
};
const files = (map: Record<string, string>) => (path: string) => {
  if (path in map) return map[path] as string;
  throw new Error("no such file");
};
const refused = (env: Record<string, string>, readFile = files({})) => {
  try {
    githubAppConfig(env, readFile);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
};

describe("the GitHub App's settings", () => {
  it("are none when none are set: the instance has no App", () => {
    expect(githubAppConfig({}, files({}))).toBeUndefined();
  });

  it("are read when all are set", () => {
    expect(githubAppConfig(FULL, files({}))).toMatchObject({ appId: "12345", slug: "my-fjord", clientId: "Iv1.abc", webhookSecret: "a-webhook-secret-of-length" });
  });

  it("can come from files, which is how a secret is passed", () => {
    const { FJORD_GITHUB_APP_PRIVATE_KEY: _key, FJORD_GITHUB_APP_WEBHOOK_SECRET: _hook, ...rest } = FULL;
    const config = githubAppConfig({ ...rest, FJORD_GITHUB_APP_PRIVATE_KEY_FILE: "/run/key", FJORD_GITHUB_APP_WEBHOOK_SECRET_FILE: "/run/hook" }, files({ "/run/key": `${privateKey}\n`, "/run/hook": "a-webhook-secret-of-length\n" }));
    expect(config?.webhookSecret).toBe("a-webhook-secret-of-length");
    expect(config?.privateKey.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("take a key whose line breaks are written as \\n, as an environment variable often has them", () => {
    expect(githubAppConfig({ ...FULL, FJORD_GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n") }, files({}))?.privateKey).toContain("\n");
  });

  it("are refused when only some are set, naming what is missing", () => {
    const { FJORD_GITHUB_APP_CLIENT_SECRET: _a, FJORD_GITHUB_APP_WEBHOOK_SECRET: _b, ...rest } = FULL;
    const message = refused(rest);
    expect(message).toContain("FJORD_GITHUB_APP_CLIENT_SECRET");
    expect(message).toContain("FJORD_GITHUB_APP_WEBHOOK_SECRET");
    expect(message).not.toContain("FJORD_GITHUB_APP_ID");
  });

  it.each([
    ["an id that is not a number", { FJORD_GITHUB_APP_ID: "abc" }, "FJORD_GITHUB_APP_ID"],
    ["a name that is not a slug", { FJORD_GITHUB_APP_SLUG: "no/slash" }, "FJORD_GITHUB_APP_SLUG"],
    ["a key that is not a key", { FJORD_GITHUB_APP_PRIVATE_KEY: "not a key" }, "FJORD_GITHUB_APP_PRIVATE_KEY"],
    ["a short webhook secret", { FJORD_GITHUB_APP_WEBHOOK_SECRET: "short" }, "FJORD_GITHUB_APP_WEBHOOK_SECRET"],
  ])("are refused with %s", (_name, change, variable) => {
    expect(refused({ ...FULL, ...change })).toContain(variable);
  });

  it("never put the key in the message that refuses it", () => {
    expect(refused({ ...FULL, FJORD_GITHUB_APP_ID: "abc" })).not.toContain("BEGIN");
    expect(refused({ ...FULL, FJORD_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nsecretsecret" })).not.toContain("secretsecret");
  });
});

describe("where people sign in to GitHub", () => {
  it("is github.com for its API, and an Enterprise Server's own address for its", () => {
    expect(githubWebUrl("https://api.github.com")).toBe("https://github.com");
    expect(githubWebUrl("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com");
  });
});
