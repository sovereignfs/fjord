import { describe, expect, it } from "vitest";
import { ConfigError } from "../db/config";
import { describeAuth, resolveAuthConfig } from "./config";

const SECRET = "s".repeat(32);
const on = { FJORD_AUTH_LOCAL: "1", FJORD_URL: "https://fjord.example.com", FJORD_AUTH_SECRET: SECRET };

describe("resolveAuthConfig", () => {
  it("is off unless FJORD_AUTH_LOCAL says on, whatever else is set", () => {
    expect(resolveAuthConfig({})).toEqual({ local: false });
    expect(resolveAuthConfig({ ...on, FJORD_AUTH_LOCAL: "" })).toEqual({ local: false });
    expect(resolveAuthConfig({ ...on, FJORD_AUTH_LOCAL: "0" })).toEqual({ local: false });
    expect(resolveAuthConfig({ ...on, FJORD_AUTH_LOCAL: "false" })).toEqual({ local: false });
    expect(resolveAuthConfig({ FJORD_URL: "x", FJORD_AUTH_SECRET: "short" })).toEqual({ local: false });
  });

  it("reads the defaults when on", () => {
    expect(resolveAuthConfig(on)).toEqual({
      local: true,
      url: "https://fjord.example.com",
      secret: SECRET,
      signUp: "closed",
      passwordMinLength: 10,
      name: "Fjord",
      passkeyRpId: "fjord.example.com",
      requireEmailVerification: false,
    });
  });

  it.each(["1", "true", "TRUE"])("is on for FJORD_AUTH_LOCAL=%s", (value) => {
    expect(resolveAuthConfig({ ...on, FJORD_AUTH_LOCAL: value }).local).toBe(true);
  });

  describe("the instance URL", () => {
    it.each([
      ["a missing one", undefined, /FJORD_URL/],
      ["one that is not a URL", "not a url", /not a valid URL/],
      ["a non-http scheme", "ftp://fjord.example.com", /http\(s\)/],
      ["plain http away from localhost", "http://fjord.example.com", /https/],
      ["a path", "https://fjord.example.com/app", /no path/],
    ])("refuses %s", (_name, url, message) => {
      expect(() => resolveAuthConfig({ ...on, FJORD_URL: url })).toThrow(message);
    });

    it("allows plain http on localhost, for development, and drops a trailing slash", () => {
      expect(resolveAuthConfig({ ...on, FJORD_URL: "http://localhost:3000/" })).toMatchObject({ url: "http://localhost:3000", passkeyRpId: "localhost" });
      expect(resolveAuthConfig({ ...on, FJORD_URL: "http://127.0.0.1:3000" })).toMatchObject({ url: "http://127.0.0.1:3000" });
    });
  });

  describe("the secret", () => {
    it("is required, and at least 32 characters", () => {
      expect(() => resolveAuthConfig({ ...on, FJORD_AUTH_SECRET: undefined })).toThrow(/FJORD_AUTH_SECRET/);
      expect(() => resolveAuthConfig({ ...on, FJORD_AUTH_SECRET: "short" })).toThrow(/at least 32/);
    });

    it("can come from a file, with the trailing newline dropped", () => {
      const config = resolveAuthConfig({ ...on, FJORD_AUTH_SECRET: undefined, FJORD_AUTH_SECRET_FILE: "/run/secrets/auth" }, () => `${SECRET}\n`);
      expect(config).toMatchObject({ secret: SECRET });
    });

    it("is not given twice, and a file that cannot be read is named", () => {
      expect(() => resolveAuthConfig({ ...on, FJORD_AUTH_SECRET_FILE: "/x" }, () => SECRET)).toThrow(/not both/);
      expect(() =>
        resolveAuthConfig({ ...on, FJORD_AUTH_SECRET: undefined, FJORD_AUTH_SECRET_FILE: "/missing" }, () => {
          throw new Error("ENOENT");
        }),
      ).toThrow(/FJORD_AUTH_SECRET_FILE names a file that cannot be read/);
    });
  });

  describe("who may sign up", () => {
    it("is the first account only, unless open", () => {
      expect(resolveAuthConfig(on)).toMatchObject({ signUp: "closed" });
      expect(resolveAuthConfig({ ...on, FJORD_AUTH_SIGNUP: "open" })).toMatchObject({ signUp: "open" });
      expect(resolveAuthConfig({ ...on, FJORD_AUTH_SIGNUP: " Closed " })).toMatchObject({ signUp: "closed" });
    });

    it("refuses anything else, rather than guessing", () => {
      expect(() => resolveAuthConfig({ ...on, FJORD_AUTH_SIGNUP: "invite" })).toThrow(/"open" or "closed"/);
    });
  });

  describe("email", () => {
    const smtp = { SMTP_HOST: "mail.example.com", SMTP_FROM: "Fjord <fjord@example.com>" };

    it("is off without SMTP_HOST, and then verification is not required", () => {
      expect(resolveAuthConfig(on)).toMatchObject({ requireEmailVerification: false });
      expect(resolveAuthConfig(on)).not.toHaveProperty("smtp");
    });

    it("turns on verification when SMTP is set", () => {
      expect(resolveAuthConfig({ ...on, ...smtp })).toMatchObject({
        requireEmailVerification: true,
        smtp: { host: "mail.example.com", port: 587, secure: false, from: "Fjord <fjord@example.com>" },
      });
    });

    it("takes the port, TLS, login and a password from a file", () => {
      const config = resolveAuthConfig({ ...on, ...smtp, SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASSWORD_FILE: "/run/secrets/smtp" }, () => "pw\n");
      expect(config).toMatchObject({ smtp: { port: 465, secure: true, user: "u", password: "pw" } });
    });

    it("needs a sender", () => {
      expect(() => resolveAuthConfig({ ...on, SMTP_HOST: "mail.example.com" })).toThrow(/SMTP_FROM/);
    });

    it("lets an operator with SMTP turn verification off, but not on without it", () => {
      expect(resolveAuthConfig({ ...on, ...smtp, FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION: "false" })).toMatchObject({ requireEmailVerification: false });
      expect(() => resolveAuthConfig({ ...on, FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION: "true" })).toThrow(/needs SMTP_HOST/);
      expect(() => resolveAuthConfig({ ...on, ...smtp, FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION: "maybe" })).toThrow(/"true" or "false"/);
    });
  });

  it("takes a password length, ignoring a bad one", () => {
    expect(resolveAuthConfig({ ...on, FJORD_AUTH_PASSWORD_MIN_LENGTH: "14" })).toMatchObject({ passwordMinLength: 14 });
    for (const bad of ["0", "-1", "long", "3.5"]) expect(resolveAuthConfig({ ...on, FJORD_AUTH_PASSWORD_MIN_LENGTH: bad })).toMatchObject({ passwordMinLength: 10 });
  });

  it("takes the instance name and the passkey relying party", () => {
    expect(resolveAuthConfig({ ...on, FJORD_NAME: "Acme Docs", FJORD_PASSKEY_RP_ID: "example.com" })).toMatchObject({ name: "Acme Docs", passkeyRpId: "example.com" });
  });

  it("raises ConfigError, which the boot reports without a stack", () => {
    expect(() => resolveAuthConfig({ ...on, FJORD_URL: "" })).toThrow(ConfigError);
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
  });

  it("says it is off", () => {
    expect(describeAuth({ local: false })).toBe("local sign-in is off");
  });
});
