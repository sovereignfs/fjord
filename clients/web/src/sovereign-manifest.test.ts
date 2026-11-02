import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { SOVEREIGN_PROVIDER_ID, SOVEREIGN_SCOPES } from "./auth/auth";

/**
 * The manifest a Sovereign instance reads to host Fjord Web (`sovereign.manifest.json`, DESIGN.md §17; the contract is
 * `contracts/app-manifest.md` in sovereignfs/sovereign). It is held here to the manifest's JSON Schema, and to the code and files it
 * makes promises about, so that a change to a route, a scope or a port that the manifest has not followed fails here and not on an
 * operator's server.
 *
 * `src/auth/fixtures/app-manifest-v2.schema.json` is a copy of that repository's `contracts/schemas/app-manifest-v2.schema.json`,
 * taken when the manifest was first written (as the discovery document beside it is a recording). When `@sovereignfs/manifest` is
 * published it replaces both this copy and `scripts/manifest.mjs`: `sovereign-manifest check` is the same test.
 */
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("sovereign.manifest.json")) as {
  manifest: number;
  prefix: string;
  port: number;
  health: string;
  launch: string;
  icon: string;
  signIn: { redirect: string[]; scopes: string[]; backChannel?: string; accountDeleted?: string; postLogout?: string[] };
  database: unknown;
  generate: (string | { name: string })[];
  core: string;
};

describe("sovereign.manifest.json", () => {
  it("meets the manifest's JSON Schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(read("src/auth/fixtures/app-manifest-v2.schema.json")));
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  });

  it("is refused by that schema when it is wrong, so the check above is a check", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(read("src/auth/fixtures/app-manifest-v2.schema.json")));
    expect(validate({ ...manifest, prefix: "Fjord" })).toBe(false);
    expect(validate({ ...manifest, port: 0 })).toBe(false);
    expect(validate({ ...manifest, extra: true })).toBe(false);
    expect(validate({ ...manifest, core: undefined })).toBe(false);
  });

  it("names the app Fjord, and its variables FJORD_", () => {
    expect(manifest.prefix).toBe("fjord");
    for (const entry of manifest.generate) {
      const name = typeof entry === "string" ? entry : entry.name;
      expect(name.startsWith(`${manifest.prefix.toUpperCase()}_`), name).toBe(true);
    }
  });

  it("asks for the secret the app needs to start, and the app reads it", () => {
    expect(manifest.generate).toContain("FJORD_AUTH_SECRET");
    expect(read("src/auth/config.ts")).toContain("FJORD_AUTH_SECRET");
  });

  it("asks core for what the sign-in asks for, and is sent back where the sign-in is sent", () => {
    expect(manifest.signIn.scopes).toEqual(SOVEREIGN_SCOPES);
    expect(manifest.signIn.redirect).toEqual([`/api/auth/callback/${SOVEREIGN_PROVIDER_ID}`]);
  });

  it("names a health route and a launch address that exist", () => {
    expect(existsSync(join(root, "app", ...manifest.health.split("/").filter(Boolean), "route.ts"))).toBe(true);
    expect(manifest.launch).toBe("/");
    expect(existsSync(join(root, "app", "page.tsx"))).toBe(true);
  });

  it("names an icon the app serves", () => {
    expect(manifest.icon).toBe("/icon.svg");
    expect(existsSync(join(root, "app", "icon.svg"))).toBe(true);
    // Served to a browser that has no session here, so the proxy leaves it alone.
    expect(read("proxy.ts")).toMatch(/matcher:[^\n]*icon\.svg/);
  });

  it("needs a database, and does not say it works through a pooler, since it holds a lock for its migrations", () => {
    expect(manifest.database).toBe(true);
  });

  it("names the addresses Sovereign sends its notices to, and routes answer them that the access list lets Sovereign into", () => {
    expect(manifest.signIn.backChannel).toBe("/api/sovereign/backchannel-logout");
    expect(manifest.signIn.accountDeleted).toBe("/api/sovereign/account-deleted");
    const routes = read("src/access/routes.ts");
    for (const address of [manifest.signIn.backChannel, manifest.signIn.accountDeleted]) {
      expect(existsSync(join(root, "app", ...(address as string).split("/").filter(Boolean), "route.ts")), address).toBe(true);
      // Sovereign has no session: its signed token is what lets a request in.
      expect(routes, address).toMatch(new RegExp(`route: "${address}", methods: \\{ POST: \\{ kind: "public" \\} \\}`));
    }
  });
});

describe("the port", () => {
  it("is written in the manifest and the image is built with it", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("ARG PORT");
    expect(dockerfile).toContain("PORT=${PORT}");
    expect(dockerfile).toContain("EXPOSE ${PORT}");
    // No other number: the health check reads PORT from the environment the image sets.
    expect(dockerfile.replace(/#[^\n]*/g, "")).not.toMatch(new RegExp(`\\b${manifest.port}\\b`));
    expect(dockerfile).toContain("manifest.mjs docker-args");
  });

  it("is the one the compose files build with and publish, which cannot read the manifest", () => {
    for (const file of ["compose.yaml", "compose.file.yaml"]) {
      const text = read(join("deploy", file));
      expect(text, file).toMatch(new RegExp(`PORT: "?${manifest.port}"?\\s*$`, "m"));
      expect(text, file).toMatch(new RegExp(`:${manifest.port}"\\s*$`, "m"));
    }
  });
});

describe("scripts/manifest.mjs", () => {
  const run = (...args: string[]) => execFileSync("node", ["scripts/manifest.mjs", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" });

  it("makes the label from the file, equal to the file, and the build argument from its port", () => {
    expect(JSON.parse(run("label"))).toEqual(manifest);
    const lines = run("docker-args", "--format", "github").trimEnd().split("\n");
    expect(lines).toEqual([`labels=io.github.sovereignfs.app-manifest=${JSON.stringify(manifest)}`, `build-args=PORT=${manifest.port}`]);
  });

  it("gives a shell one line that a shell reads back as the label and the port", () => {
    const line = run("docker-args").trimEnd();
    // `printf '%s\n'` after the shell has taken the quotes off: one word each, in order.
    const words = execFileSync("sh", ["-c", `eval "printf '%s\\n' ${line.replace(/(["\\$`])/g, "\\$1")}"`], { encoding: "utf8" }).trimEnd().split("\n");
    expect(words).toEqual(["--label", `io.github.sovereignfs.app-manifest=${JSON.stringify(manifest)}`, "--build-arg", `PORT=${manifest.port}`]);
  });

  it("checks the file, and is a usage error for what it does not know", () => {
    expect(run("check")).toContain("is a manifest 2");
    expect(() => run("build")).toThrow();
    expect(() => run("docker-args", "--format", "yaml")).toThrow();
  });
});
