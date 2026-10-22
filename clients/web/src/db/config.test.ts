import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, resolveDatabaseConfig } from "./config";

describe("resolveDatabaseConfig", () => {
  it("defaults to SQLite through an sqld service", () => {
    expect(resolveDatabaseConfig({})).toEqual({
      dialect: "sqlite",
      form: "sqld",
      url: "http://sqld:8080",
      adminUrl: "http://sqld:8081",
    });
  });

  it("treats an empty DB_DIALECT as unset, and ignores case and spaces", () => {
    expect(resolveDatabaseConfig({ DB_DIALECT: "" }).dialect).toBe("sqlite");
    expect(resolveDatabaseConfig({ DB_DIALECT: " SQLite " }).dialect).toBe("sqlite");
  });

  it("reads an sqld URL and its admin URL, without a trailing slash", () => {
    expect(resolveDatabaseConfig({ SQLITE_URL: "http://localhost:28080/", SQLD_ADMIN_URL: "http://localhost:28081/" })).toEqual({
      dialect: "sqlite",
      form: "sqld",
      url: "http://localhost:28080",
      adminUrl: "http://localhost:28081",
    });
  });

  it.each([
    ["file:/data/fjord.db", "/data/fjord.db", "/data/fjord_auth.db"],
    ["file:///data/fjord.db", "/data/fjord.db", "/data/fjord_auth.db"],
    ["file:./data/fjord.db", "./data/fjord.db", "./data/fjord_auth.db"],
    ["file:fjord.db", "fjord.db", "fjord_auth.db"],
  ])("reads the file form %s, and puts the auth database beside it", (url, path, authPath) => {
    expect(resolveDatabaseConfig({ SQLITE_URL: url })).toEqual({ dialect: "sqlite", form: "file", path, authPath });
  });

  it.each(["file:", "file:///", "file::memory:", "file:/data/"])("refuses the file URL %s", (url) => {
    expect(() => resolveDatabaseConfig({ SQLITE_URL: url })).toThrow(ConfigError);
  });

  it("refuses a SQLite URL that is neither http(s) nor file", () => {
    expect(() => resolveDatabaseConfig({ SQLITE_URL: "libsql://example.turso.io" })).toThrow(/SQLITE_URL/);
    expect(() => resolveDatabaseConfig({ SQLITE_URL: "not a url" })).toThrow(/SQLITE_URL is not a valid URL/);
  });

  it("refuses an admin URL that is not http(s)", () => {
    expect(() => resolveDatabaseConfig({ SQLD_ADMIN_URL: "ftp://sqld:8081" })).toThrow(/SQLD_ADMIN_URL/);
  });

  it("reads PostgreSQL, with a default pool size", () => {
    expect(resolveDatabaseConfig({ DB_DIALECT: "postgres", POSTGRES_DB_URL: "postgres://u:p@db:5432/fjord" })).toEqual({
      dialect: "postgres",
      url: "postgres://u:p@db:5432/fjord",
      poolMax: 5,
    });
  });

  it("requires POSTGRES_DB_URL for PostgreSQL, and it must be a postgres URL", () => {
    expect(() => resolveDatabaseConfig({ DB_DIALECT: "postgres" })).toThrow(/POSTGRES_DB_URL/);
    expect(() => resolveDatabaseConfig({ DB_DIALECT: "postgres", POSTGRES_DB_URL: "http://db" })).toThrow(/postgres:\/\//);
  });

  it("does not infer the dialect from a URL", () => {
    // A PostgreSQL URL with the default dialect is a mistake to report, not a hint.
    const config = resolveDatabaseConfig({ POSTGRES_DB_URL: "postgres://u:p@db/fjord" });
    expect(config.dialect).toBe("sqlite");
  });

  it("refuses an unknown dialect", () => {
    expect(() => resolveDatabaseConfig({ DB_DIALECT: "mysql" })).toThrow(/DB_DIALECT must be "sqlite" or "postgres"/);
  });

  it("takes the pool size and CA file for PostgreSQL, and ignores a bad pool size", () => {
    const base = { DB_DIALECT: "postgres", POSTGRES_DB_URL: "postgres://u:p@db/fjord" };
    expect(resolveDatabaseConfig({ ...base, POSTGRES_POOL_MAX: "12", PGSSLROOTCERT: "/ca.pem" })).toMatchObject({
      poolMax: 12,
      sslRootCertPath: "/ca.pem",
    });
    for (const bad of ["0", "-3", "many", "2.5", ""]) {
      expect(resolveDatabaseConfig({ ...base, POSTGRES_POOL_MAX: bad })).toMatchObject({ poolMax: 5 });
    }
  });
});

describe("describeConfig", () => {
  it("never prints a password", () => {
    const text = describeConfig(resolveDatabaseConfig({ DB_DIALECT: "postgres", POSTGRES_DB_URL: "postgres://fjord:hunter2@db:5432/app" }));
    expect(text).toBe("postgres db:5432/app");
    expect(text).not.toContain("hunter2");
  });

  it("describes the SQLite forms", () => {
    expect(describeConfig(resolveDatabaseConfig({}))).toBe("sqlite via sqld at http://sqld:8080");
    expect(describeConfig(resolveDatabaseConfig({ SQLITE_URL: "file:/d/f.db" }))).toBe("sqlite file /d/f.db");
  });
});
