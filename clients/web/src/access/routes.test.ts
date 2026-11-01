import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, can } from "./policy";
import { ROUTES, type RouteRule } from "./routes";

/**
 * Every route says who may use it (ROADMAP 1c.1): the files under `app/` are held to the table in `routes.ts`, both ways. A
 * new page or endpoint with no entry fails here, as does an entry whose route is gone or that names a method it does not
 * answer, so that "who may call this" is answered before a route is merged and cannot drift afterwards.
 */
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** The HTTP methods a route file exports, in any of the ways Next.js takes them. */
export function exportedMethods(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:async\s+function|const|function)\s+([A-Z]+)\b/g)) if (METHODS.has(match[1]!)) found.add(match[1]!);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (METHODS.has(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/** Every page and API route under an `app` directory, as the router spells it, with what a route file answers. */
export function findRoutes(appDir: string): { route: string; kind: "page" | "api"; methods: string[] }[] {
  const out: { route: string; kind: "page" | "api"; methods: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name !== "page.tsx" && entry.name !== "route.ts") continue;
      const segments = relative(appDir, dir).split(sep).filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment));
      const route = `/${segments.join("/")}`;
      out.push(entry.name === "page.tsx" ? { route, kind: "page", methods: [] } : { route, kind: "api", methods: exportedMethods(readFileSync(path, "utf8")) });
    }
  };
  walk(appDir);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/** What is wrong between the files and the table: routes with no rule, rules with no route, methods that do not match. */
export function problems(found: ReturnType<typeof findRoutes>, rules: RouteRule[]): string[] {
  const problems: string[] = [];
  const byRoute = new Map(rules.map((rule) => [rule.route, rule]));
  for (const file of found) {
    const rule = byRoute.get(file.route);
    if (!rule) {
      problems.push(`${file.kind === "page" ? "page" : "API route"} ${file.route} has no rule in routes.ts: say who may use it`);
    } else if (file.kind === "page" && !rule.page) {
      problems.push(`${file.route} is a page and its rule has no \`page\``);
    } else if (file.kind === "api" && JSON.stringify(Object.keys(rule.methods ?? {}).sort()) !== JSON.stringify(file.methods)) {
      problems.push(`${file.route} answers ${file.methods.join(", ") || "nothing"} and its rule says ${Object.keys(rule.methods ?? {}).sort().join(", ") || "nothing"}`);
    }
  }
  for (const rule of rules) if (!found.some((file) => file.route === rule.route)) problems.push(`${rule.route} has a rule and no route`);
  return problems;
}

describe("every route says who may use it", () => {
  it("has a rule for each page and API route under app/, and no rule for one that is gone", () => {
    expect(problems(findRoutes(join(process.cwd(), "app")), ROUTES)).toEqual([]);
  });

  it("has one rule for each route, and each rule says something", () => {
    expect(new Set(ROUTES.map((rule) => rule.route)).size).toBe(ROUTES.length);
    for (const rule of ROUTES) expect(rule.page !== undefined || Object.keys(rule.methods ?? {}).length > 0, rule.route).toBe(true);
  });

  it("names, for what belongs to an owner, an action the policy knows", () => {
    for (const rule of ROUTES) for (const access of [rule.page, ...Object.values(rule.methods ?? {})]) if (access?.kind === "resource") expect(ACTIONS, rule.route).toContain(access.action);
  });

  it("asks the action a route is named for: what deletes asks to delete, and so on", () => {
    const named: Record<string, string> = {
      "/api/connections/[id]/files": "create",
      "/api/connections/[id]/files/encrypted": "create",
      "/api/connections/[id]/files/delete": "delete",
      "/api/connections/[id]/files/move": "move",
      "/api/connections/[id]/files/restore": "restore",
      "/api/connections/[id]/working-copy/version": "save_version",
      "/deleted/[connection]": "restore",
      "/doc/[id]/draft": "edit",
    };
    const sharing = ROUTES.find((candidate) => candidate.route === "/api/connections/[id]/shares")!;
    expect(Object.values(sharing.methods ?? {}).map((access) => (access.kind === "resource" ? access.action : null))).toEqual(["manage_shares", "manage_shares", "manage_shares"]);
    const talking = ROUTES.find((candidate) => candidate.route === "/doc/[id]/comments")!;
    expect(Object.entries(talking.methods ?? {}).map(([method, access]) => [method, access.kind === "resource" ? access.action : null])).toEqual([["GET", "read"], ["POST", "comment"], ["PATCH", "resolve"], ["DELETE", "delete_own_comment"]]);
    const linking = ROUTES.find((candidate) => candidate.route === "/api/connections/[id]/links")!;
    expect(Object.values(linking.methods ?? {}).map((access) => (access.kind === "resource" ? access.action : null))).toEqual(["manage_shares", "manage_shares", "manage_shares", "manage_shares"]);
    for (const [route, action] of Object.entries(named)) {
      const rule = ROUTES.find((candidate) => candidate.route === route)!;
      const asked = [rule.page, ...Object.values(rule.methods ?? {})].filter((access) => access !== undefined).map((access) => (access.kind === "resource" ? access.action : null));
      expect(asked, route).toEqual([action]);
    }
  });

  it("never lets a share reach what makes a version, renames, moves, deletes, restores or shares", () => {
    for (const rule of ROUTES) {
      for (const access of [rule.page, ...Object.values(rule.methods ?? {})]) {
        if (access?.kind !== "resource") continue;
        if (!["save_version", "create", "rename", "move", "delete", "restore", "manage_shares", "moderate_comments"].includes(access.action)) continue;
        for (const role of ROLES) for (const grant of [{ kind: "user", role }, { kind: "link", role }] as const) expect(can([grant], access.action, { kind: "document" }, 0), `${rule.route} ${access.action}`).toBe(false);
      }
    }
  });
});

describe("the check can fail", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "fjord-routes-"));
  const file = (root: string, path: string, content: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  it("reports a route with no rule, a rule with no route, and a method that does not match", () => {
    const root = scratch();
    try {
      file(root, "page.tsx", "");
      file(root, "api/open/route.ts", "export async function GET() {}\nexport async function DELETE() {}");
      file(root, "api/new/route.ts", "export async function POST() {}");
      file(root, "(group)/hidden/page.tsx", "");
      const rules: RouteRule[] = [
        { route: "/", page: { kind: "public" } },
        { route: "/api/open", methods: { GET: { kind: "public" } } },
        { route: "/gone", page: { kind: "public" } },
      ];
      expect(problems(findRoutes(root), rules).sort()).toEqual(
        [
          "/api/open answers DELETE, GET and its rule says GET",
          "/gone has a rule and no route",
          "API route /api/new has no rule in routes.ts: say who may use it",
          "page /hidden has no rule in routes.ts: say who may use it",
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the ways a route file exports its methods", () => {
    expect(exportedMethods("export async function POST() {}")).toEqual(["POST"]);
    expect(exportedMethods("const handle = () => {};\nexport { handle as DELETE, handle as PUT };")).toEqual(["DELETE", "PUT"]);
    expect(exportedMethods("export const GET = () => {};\nexport const dynamic = 'force-dynamic';")).toEqual(["GET"]);
    expect(exportedMethods("export const { GET, POST } = handler;")).toEqual([]);
    expect(exportedMethods("export const dynamic = 'x';")).toEqual([]);
  });
});
