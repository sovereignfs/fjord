import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@sovereignfs/manifest";
import { describe, expect, it } from "vitest";
import { SOVEREIGN_PROVIDER_ID, SOVEREIGN_SCOPES } from "./auth/auth";

/**
 * The manifest a Sovereign instance reads to host Fjord Web (`sovereign.manifest.json`, DESIGN.md §17; the contract is
 * `contracts/app-manifest.md` in sovereignfs/sovereign). It is held here to the manifest's JSON Schema, and to the code and files it
 * makes promises about, so that a change to a route, a scope or a port that the manifest has not followed fails here and not on an
 * operator's server.
 *
 * The schema and the rules a schema cannot say are `@sovereignfs/manifest`'s, the package the instance's own toolkit validates with, and
 * its `sovereign-manifest` command makes the image's label and port (`pnpm manifest:check` runs the same check).
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
  it("is a manifest the instance's toolkit accepts", () => {
    expect(validate(manifest)).toMatchObject({ ok: true });
  });

  it("is refused when it is wrong, so the check above is a check", () => {
    expect(validate({ ...manifest, prefix: "Fjord" }).ok).toBe(false);
    expect(validate({ ...manifest, port: 0 }).ok).toBe(false);
    expect(validate({ ...manifest, extra: true }).ok).toBe(false);
    expect(validate({ ...manifest, core: undefined }).ok).toBe(false);
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
    expect(dockerfile).toContain("sovereign-manifest docker-args");
  });

  it("is the one the compose files build with and publish, which cannot read the manifest", () => {
    for (const file of ["compose.yaml", "compose.file.yaml"]) {
      const text = read(join("deploy", file));
      expect(text, file).toMatch(new RegExp(`PORT: "?${manifest.port}"?\\s*$`, "m"));
      expect(text, file).toMatch(new RegExp(`:${manifest.port}"\\s*$`, "m"));
    }
  });
});

describe("the port on a developer's machine", () => {
  it("is the manifest's, so the suite's apps (core 3000, Fjord 3001, Tusk 3002) run side by side", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(scripts.dev).toContain(`--port ${manifest.port}`);
    expect(scripts.start).toContain(`\${PORT:-${manifest.port}}`);
    expect(read(join("deploy", ".env.example"))).toContain(`FJORD_URL=http://localhost:${manifest.port}`);
  });
});

describe("sovereign-manifest, which builds the image from the file", () => {
  const run = (...args: string[]) =>
    execFileSync(join(root, "node_modules/.bin/sovereign-manifest"), args, { cwd: root, encoding: "utf8", stdio: "pipe" });

  it("is the version CI and the release run, which install it on their own", () => {
    const { devDependencies } = JSON.parse(read("package.json")) as { devDependencies: Record<string, string> };
    const version = devDependencies["@sovereignfs/manifest"];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const workflow of ["web-ci.yml", "web-release.yml"]) {
      expect(read(join("..", "..", ".github", "workflows", workflow)), workflow).toContain(`@sovereignfs/manifest@${version} sovereign-manifest docker-args`);
    }
  });

  it("makes the label from the file, equal to the file, and the build argument from its port", () => {
    expect(JSON.parse(run("label"))).toEqual(manifest);
    const lines = run("docker-args", "--format", "github").trimEnd().split("\n");
    expect(lines[1]).toBe(`build-args=PORT=${manifest.port}`);
    // The build action reads `labels` as CSV, in which a field that opens with a quote ends at its closing one, so the label is one such field.
    const field = (lines[0] ?? "").slice("labels=".length);
    expect(field.startsWith('"') && field.endsWith('"')).toBe(true);
    expect(field.slice(1, -1).replace(/""/g, '"')).toBe(`io.github.sovereignfs.app-manifest=${JSON.stringify(manifest)}`);
  });

  it("gives a shell one line that a shell reads back as the label and the port", () => {
    const line = run("docker-args").trimEnd();
    // `printf '%s\n'` after the shell has taken the quotes off: one word each, in order.
    const words = execFileSync("sh", ["-c", `eval "printf '%s\\n' ${line.replace(/(["\\$`])/g, "\\$1")}"`], { encoding: "utf8" }).trimEnd().split("\n");
    expect(words).toEqual(["--label", `io.github.sovereignfs.app-manifest=${JSON.stringify(manifest)}`, "--build-arg", `PORT=${manifest.port}`]);
  });

  it("checks the file, and is a usage error for what it does not know", () => {
    expect(run("check")).toContain("is a valid manifest 2");
    expect(() => run("build")).toThrow();
  });
});
