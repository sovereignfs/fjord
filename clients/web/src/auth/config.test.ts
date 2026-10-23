import { describe, expect, it } from "vitest";
import { ConfigError } from "../db/config";
import { describeAuth, resolveAuthConfig } from "./config";

const SECRET = "s".repeat(32);
const on = { FJORD_AUTH_LOCAL: "1", FJORD_URL: "https://fjord.example.com", FJORD_AUTH_SECRET: SECRET };

/** The instance's settings with local sign-in's beside them, which is how most of these read. */
function flat(...args: Parameters<typeof resolveAuthConfig>) {
  const config = resolveAuthConfig(...args);
  return config.enabled ? { ...config, ...config.local } : config;
}

describe("resolveAuthConfig", () => {
  it("is off unless FJORD_AUTH_LOCAL says on, whatever else is set", () => {
    expect(flat({})).toEqual({ enabled: false });
    expect(flat({ ...on, FJORD_AUTH_LOCAL: "" })).toEqual({ enabled: false });
    expect(flat({ ...on, FJORD_AUTH_LOCAL: "0" })).toEqual({ enabled: false });
    expect(flat({ ...on, FJORD_AUTH_LOCAL: "false" })).toEqual({ enabled: false });
    expect(flat({ FJORD_URL: "x", FJORD_AUTH_SECRET: "short" })).toEqual({ enabled: false });
  });

  it("reads the defaults when on", () => {
    expect(resolveAuthConfig(on)).toEqual({
      enabled: true,
      url: "https://fjord.example.com",
      secret: SECRET,
      signUp: "closed",
      name: "Fjord",
      local: { passwordMinLength: 10, passkeyRpId: "fjord.example.com", requireEmailVerification: false },
    });
  });

  it.each(["1", "true", "TRUE"])("is on for FJORD_AUTH_LOCAL=%s", (value) => {
    expect(resolveAuthConfig({ ...on, FJORD_AUTH_LOCAL: value }).enabled).toBe(true);
  });

  describe("the instance URL", () => {
    it.each([
      ["a missing one", undefined, /FJORD_URL/],
      ["one that is not a URL", "not a url", /not a valid URL/],
      ["a non-http scheme", "ftp://fjord.example.com", /http\(s\)/],
      ["plain http away from localhost", "http://fjord.example.com", /https/],
      ["a path", "https://fjord.example.com/app", /no path/],
    ])("refuses %s", (_name, url, message) => {
      expect(() => flat({ ...on, FJORD_URL: url })).toThrow(message);
    });

    it("allows plain http on localhost, for development, and drops a trailing slash", () => {
      expect(flat({ ...on, FJORD_URL: "http://localhost:3000/" })).toMatchObject({ url: "http://localhost:3000", passkeyRpId: "localhost" });
      expect(flat({ ...on, FJORD_URL: "http://127.0.0.1:3000" })).toMatchObject({ url: "http://127.0.0.1:3000" });
    });
  });

  describe("the secret", () => {
    it("is required, and at least 32 characters", () => {
      expect(() => flat({ ...on, FJORD_AUTH_SECRET: undefined })).toThrow(/FJORD_AUTH_SECRET/);
      expect(() => flat({ ...on, FJORD_AUTH_SECRET: "short" })).toThrow(/at least 32/);
    });

    it("can come from a file, with the trailing newline dropped", () => {
      const config = flat({ ...on, FJORD_AUTH_SECRET: undefined, FJORD_AUTH_SECRET_FILE: "/run/secrets/auth" }, () => `${SECRET}\n`);
      expect(config).toMatchObject({ secret: SECRET });
    });

    it("is not given twice, and a file that cannot be read is named", () => {
      expect(() => flat({ ...on, FJORD_AUTH_SECRET_FILE: "/x" }, () => SECRET)).toThrow(/not both/);
      expect(() =>
        flat({ ...on, FJORD_AUTH_SECRET: undefined, FJORD_AUTH_SECRET_FILE: "/missing" }, () => {
          throw new Error("ENOENT");
        }),
      ).toThrow(/FJORD_AUTH_SECRET_FILE names a file that cannot be read/);
    });
  });

  describe("who may sign up", () => {
    it("is the first account only, unless open", () => {
      expect(flat(on)).toMatchObject({ signUp: "closed" });
      expect(flat({ ...on, FJORD_AUTH_SIGNUP: "open" })).toMatchObject({ signUp: "open" });
      expect(flat({ ...on, FJORD_AUTH_SIGNUP: " Closed " })).toMatchObject({ signUp: "closed" });
    });

    it("refuses anything else, rather than guessing", () => {
      expect(() => flat({ ...on, FJORD_AUTH_SIGNUP: "invite" })).toThrow(/"open" or "closed"/);
    });
  });

  describe("email", () => {
    const smtp = { SMTP_HOST: "mail.example.com", SMTP_FROM: "Fjord <fjord@example.com>" };

    it("is off without SMTP_HOST, and then verification is not required", () => {
      expect(flat(on)).toMatchObject({ requireEmailVerification: false });
      expect(flat(on)).not.toHaveProperty("smtp");
    });

    it("turns on verification when SMTP is set", () => {
      expect(flat({ ...on, ...smtp })).toMatchObject({
        requireEmailVerification: true,
        smtp: { host: "mail.example.com", port: 587, secure: false, from: "Fjord <fjord@example.com>" },
      });
    });

    it("takes the port, TLS, login and a password from a file", () => {
      const config = flat({ ...on, ...smtp, SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASSWORD_FILE: "/run/secrets/smtp" }, () => "pw\n");
      expect(config).toMatchObject({ smtp: { port: 465, secure: true, user: "u", password: "pw" } });
    });

    it("needs a sender", () => {
      expect(() => flat({ ...on, SMTP_HOST: "mail.example.com" })).toThrow(/SMTP_FROM/);
    });

    it("lets an operator with SMTP turn verification off, but not on without it", () => {
      expect(flat({ ...on, ...smtp, FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION: "false" })).toMatchObject({ requireEmailVerification: false });
      expect(() => flat({ ...on, FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION: "true" })).toThrow(/needs SMTP_HOST/);
      expect(() => flat({ ...on, ...smtp, FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION: "maybe" })).toThrow(/"true" or "false"/);
    });
  });

  it("takes a password length, ignoring a bad one", () => {
    expect(flat({ ...on, FJORD_AUTH_PASSWORD_MIN_LENGTH: "14" })).toMatchObject({ passwordMinLength: 14 });
    for (const bad of ["0", "-1", "long", "3.5"]) expect(flat({ ...on, FJORD_AUTH_PASSWORD_MIN_LENGTH: bad })).toMatchObject({ passwordMinLength: 10 });
  });

  it("takes the instance name and the passkey relying party", () => {
    expect(flat({ ...on, FJORD_NAME: "Acme Docs", FJORD_PASSKEY_RP_ID: "example.com" })).toMatchObject({ name: "Acme Docs", passkeyRpId: "example.com" });
  });

  describe("Sovereign sign-in", () => {
    const base = { FJORD_URL: "https://fjord.example.com", FJORD_AUTH_SECRET: SECRET };
    const sov = {
      FJORD_AUTH_SOVEREIGN_ISSUER: "https://auth.sovereign.example.com/api/auth/",
      FJORD_AUTH_SOVEREIGN_CLIENT_ID: "client-1",
      FJORD_AUTH_SOVEREIGN_CLIENT_SECRET: "shh",
    };

    it("is on by itself, without local sign-in, and normalises the issuer", () => {
      expect(resolveAuthConfig({ ...base, ...sov })).toEqual({
        enabled: true,
        url: "https://fjord.example.com",
        secret: SECRET,
        signUp: "closed",
        name: "Fjord",
        sovereign: { issuer: "https://auth.sovereign.example.com/api/auth", clientId: "client-1", clientSecret: "shh" },
      });
    });

    it("can be on beside local sign-in", () => {
      expect(resolveAuthConfig({ ...on, ...sov })).toMatchObject({ enabled: true, local: expect.any(Object), sovereign: expect.any(Object) });
    });

    it("is off when none of its three settings are set, and an error when only some are", () => {
      expect(resolveAuthConfig(base)).toEqual({ enabled: false });
      expect(() => resolveAuthConfig({ ...base, FJORD_AUTH_SOVEREIGN_ISSUER: sov.FJORD_AUTH_SOVEREIGN_ISSUER })).toThrow(/missing FJORD_AUTH_SOVEREIGN_CLIENT_ID, FJORD_AUTH_SOVEREIGN_CLIENT_SECRET/);
    });

    it("needs the instance URL and secret too", () => {
      expect(() => resolveAuthConfig({ ...sov, FJORD_AUTH_SECRET: SECRET })).toThrow(/FJORD_URL/);
      expect(() => resolveAuthConfig({ ...sov, FJORD_URL: base.FJORD_URL })).toThrow(/FJORD_AUTH_SECRET/);
    });

    it("takes the client secret from a file", () => {
      const { FJORD_AUTH_SOVEREIGN_CLIENT_SECRET: _drop, ...rest } = sov;
      const config = resolveAuthConfig({ ...base, ...rest, FJORD_AUTH_SOVEREIGN_CLIENT_SECRET_FILE: "/run/secrets/sov" }, () => "from-file\n");
      expect(config).toMatchObject({ sovereign: { clientSecret: "from-file" } });
    });

    it("insists on https for the issuer, except on localhost, and on no query", () => {
      expect(() => resolveAuthConfig({ ...base, ...sov, FJORD_AUTH_SOVEREIGN_ISSUER: "http://auth.example.com" })).toThrow(/https/);
      expect(() => resolveAuthConfig({ ...base, ...sov, FJORD_AUTH_SOVEREIGN_ISSUER: "https://auth.example.com/?x=1" })).toThrow(/no query/);
      expect(() => resolveAuthConfig({ ...base, ...sov, FJORD_AUTH_SOVEREIGN_ISSUER: "nope" })).toThrow(/not a valid URL/);
      expect(resolveAuthConfig({ ...base, ...sov, FJORD_AUTH_SOVEREIGN_ISSUER: "http://localhost:4000" })).toMatchObject({ sovereign: { issuer: "http://localhost:4000" } });
    });
  });

  it("raises ConfigError, which the boot reports without a stack", () => {
    expect(() => flat({ ...on, FJORD_URL: "" })).toThrow(ConfigError);
  });
});

describe("describeAuth", () => {
  it("never prints a secret or a password", () => {
    const text = describeAuth(
      resolveAuthConfig({ ...on, SMTP_HOST: "mail.example.com", SMTP_FROM: "a@b.c", SMTP_PASSWORD: "hunter2hunter2" }),
    );
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("fjord.example.com");
    expect(text).toContain("local");
  });

  it("names the issuer but never the client secret", () => {
    const text = describeAuth(
      resolveAuthConfig({
        ...on,
        FJORD_AUTH_SOVEREIGN_ISSUER: "https://auth.sovereign.example.com/api/auth",
        FJORD_AUTH_SOVEREIGN_CLIENT_ID: "client-1",
        FJORD_AUTH_SOVEREIGN_CLIENT_SECRET: "topsecretvalue",
      }),
    );
    expect(text).toContain("Sovereign (https://auth.sovereign.example.com/api/auth)");
    expect(text).not.toContain("topsecretvalue");
  });

  it("says it is off", () => {
    expect(describeAuth({ enabled: false })).toBe("sign-in is off");
  });
});
