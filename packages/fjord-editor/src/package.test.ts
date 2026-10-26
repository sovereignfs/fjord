// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { themeTokens } from "./theme.js";

/**
 * What the package promises about itself (clients/web/DESIGN.md §18, §19 #4): it is MPL-2.0 and depends on no client's
 * design system, so any client can embed it; it is styled only through its own custom properties; and the only
 * things a client can import are its entry point and its stylesheet.
 */
const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  license: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports: Record<string, unknown>;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    // This file names the thing it forbids, so it is not read for it.
    return /\.(ts|tsx|css)$/.test(name) && name !== "package.test.ts" ? [path] : [];
  });
}

describe("the package", () => {
  it("is MPL-2.0, with the licence in it", () => {
    expect(manifest.license).toBe("MPL-2.0");
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("Mozilla Public License Version 2.0");
  });

  it("needs React and an editor core's own packages at run time, and never a client's design system", () => {
    // The cores are CodeMirror's packages (and, with 1b.3, MDXEditor's). Anything else is a decision, so it is listed.
    const cores = [/^@codemirror\//, /^@lezer\//];
    for (const name of Object.keys(manifest.dependencies ?? {})) expect(cores.some((core) => core.test(name)), `${name} is not an editor core's package`).toBe(true);
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(["react"]);
    for (const file of sourceFiles(join(root, "src")).concat(sourceFiles(join(root, "stories")))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/@sovereignfs/);
      for (const [, specifier] of text.matchAll(/from\s+"([^"]+)"/g)) {
        const from = specifier as string;
        const fine = from.startsWith(".") || from === "react" || from.startsWith("@codemirror/") || from.startsWith("@lezer/") || from.startsWith("vitest") || from.startsWith("@testing-library/") || from.startsWith("node:") || from === "@ladle/react";
        expect(fine, `${file} imports ${from}`).toBe(true);
      }
    }
  });

  it("depends only on packages whose licence can be combined with MPL-2.0 and with the clients' own", () => {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const licence = (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { license?: string }).license;
      expect(licence, name).toBe("MIT");
    }
  });

  it("lets a client import its entry point and its stylesheet, and nothing deeper", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./package.json", "./styles.css"]);
  });

  it("styles only through its own custom properties, each with a default, and uses a colour only as one", () => {
    const css = readFileSync(join(root, "src", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)\s*(,[^)]*)?\)/g)];
    expect(used.length).toBeGreaterThan(5);
    for (const [, name, fallback] of used) {
      expect(themeTokens as readonly string[], `${name} is not a theme token`).toContain(name);
      expect(fallback, `${name} has no default`).toBeTruthy();
    }
    // A colour written anywhere but as a default inside var() would not follow the client's palette.
    const outside = css.replace(/var\([^)]*\)/g, "");
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("documents every token the stylesheet could use, and no other", () => {
    const css = readFileSync(join(root, "src", "styles.css"), "utf8");
    for (const token of themeTokens) expect(css, `${token} is listed but the stylesheet never uses it`).toContain(token);
  });
});
