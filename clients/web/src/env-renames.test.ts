import { describe, expect, it } from "vitest";
import { databaseEnv, oldNamesInUse, smtpEnv, sovereignEnv } from "./env-renames";

describe("oldNamesInUse", () => {
  it("is empty for an environment with only the new names", () => {
    expect(oldNamesInUse({ FJORD_DB_DIALECT: "postgres", FJORD_POSTGRES_URL: "postgres://db/x", FJORD_CORE_URL: "https://s.example", FJORD_SMTP_HOST: "m" })).toEqual([]);
  });

  it("names each old name that is set, with its new one, and never a value", () => {
    const names = oldNamesInUse({
      DB_DIALECT: "postgres",
      POSTGRES_DB_URL: "postgres://u:hunter2@db/x",
      FJORD_AUTH_SOVEREIGN_CLIENT_SECRET_FILE: "/run/secrets/sov",
      SMTP_HOST: "mail.example.com",
      SQLITE_URL: "",
    });
    expect(names).toEqual([
      "DB_DIALECT (now FJORD_DB_DIALECT: sqld, sqlite or postgres)",
      "POSTGRES_DB_URL (now FJORD_POSTGRES_URL)",
      "FJORD_AUTH_SOVEREIGN_CLIENT_SECRET_FILE (now FJORD_CORE_CLIENT_SECRET_FILE)",
      "SMTP_HOST (now FJORD_SMTP_HOST)",
    ]);
    expect(names.join(" ")).not.toContain("hunter2");
  });
});

describe("the renames", () => {
  it("leave an environment with no old names as it is", () => {
    const env = { FJORD_CORE_URL: "https://s.example" };
    expect(sovereignEnv(env)).toBe(env);
    expect(smtpEnv(env)).toBe(env);
    expect(databaseEnv(env)).toBe(env);
  });

  it("copy an old name to its new one, keeping the old one", () => {
    expect(smtpEnv({ SMTP_PASSWORD_FILE: "/s" })).toEqual({ SMTP_PASSWORD_FILE: "/s", FJORD_SMTP_PASSWORD_FILE: "/s" });
  });

  it("map an sqld address, a file and PostgreSQL to the new dialects", () => {
    expect(databaseEnv({ SQLITE_URL: "http://sqld:8080" })).toMatchObject({ FJORD_DB_DIALECT: "sqld", FJORD_SQLD_URL: "http://sqld:8080" });
    expect(databaseEnv({ SQLD_ADMIN_URL: "http://sqld:8081" })).toMatchObject({ FJORD_DB_DIALECT: "sqld", FJORD_SQLD_ADMIN_URL: "http://sqld:8081" });
    expect(databaseEnv({ SQLITE_URL: "file:/data/fjord.db" })).toMatchObject({ FJORD_DB_DIALECT: "sqlite", FJORD_SQLITE_URL: "file:/data/fjord.db" });
    expect(databaseEnv({ DB_DIALECT: "Postgres", POSTGRES_DB_URL: "postgres://db/x" })).toMatchObject({ FJORD_DB_DIALECT: "postgres", FJORD_POSTGRES_URL: "postgres://db/x" });
  });
});
