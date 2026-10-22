import { describe, expect, it } from "vitest";
import { themeScript } from "./script";

/** Run the script against a stand-in for the browser, and let the test change the system theme. */
function run(initiallyDark: boolean) {
  const attributes: Record<string, string> = {};
  let listener: (() => void) | undefined;
  const query = {
    matches: initiallyDark,
    addEventListener: (_: string, fn: () => void) => (listener = fn),
  };
  const window = { matchMedia: () => query };
  const document = { documentElement: { setAttribute: (name: string, value: string) => (attributes[name] = value) } };
  new Function("window", "document", themeScript)(window, document);
  return {
    theme: () => attributes["data-theme"],
    systemChangesTo(dark: boolean) {
      query.matches = dark;
      listener?.();
    },
  };
}

describe("themeScript", () => {
  it("sets the dark theme for a visitor whose system is dark", () => {
    expect(run(true).theme()).toBe("dark");
  });

  it("sets the light theme otherwise", () => {
    expect(run(false).theme()).toBe("light");
  });

  it("follows the system when it changes", () => {
    const page = run(false);
    page.systemChangesTo(true);
    expect(page.theme()).toBe("dark");
    page.systemChangesTo(false);
    expect(page.theme()).toBe("light");
  });

  it("does not throw where there is no matchMedia, leaving the page as it is", () => {
    expect(() => new Function("window", "document", themeScript)({}, {})).not.toThrow();
  });
});
