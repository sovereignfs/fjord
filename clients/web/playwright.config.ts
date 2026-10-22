import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (`pnpm build && pnpm e2e`): the real app, built, in a real browser. They are
 * where the things a unit test cannot show are shown: a passkey (a browser feature, with a
 * virtual authenticator standing in for a device), the redirect after a password, the page a
 * visitor actually sees.
 *
 * Three instances of the app run, each on a file database of its own, because what is under
 * test differs by how the instance is set up:
 *   open    local sign-in on, anyone may sign up        (e2e/*.open.spec.ts)
 *   closed  local sign-in on, only the first account    (e2e/*.closed.spec.ts)
 *   off     local sign-in not switched on               (e2e/*.off.spec.ts)
 *
 * The secret below is for these throwaway instances only.
 */
const data = mkdtempSync(join(tmpdir(), "fjord-e2e-"));
const SECRET = "e2e-only-secret-not-for-anything-real-0123456789";

// A directory of its own for each instance: the auth database is `fjord_auth.db` beside the
// app's, so two instances in one directory would share their accounts.
const instance = (name: string, port: number, env: Record<string, string>) => {
  const directory = join(data, name);
  mkdirSync(directory, { recursive: true });
  return {
    command: `pnpm exec next start --port ${port}`,
    url: `http://localhost:${port}/api/health`,
    timeout: 90_000,
    reuseExistingServer: false,
    env: { DB_DIALECT: "sqlite", SQLITE_URL: `file:${join(directory, "fjord.db")}`, ...env },
  };
};

const on = (port: number) => ({ FJORD_AUTH_LOCAL: "1", FJORD_URL: `http://localhost:${port}`, FJORD_AUTH_SECRET: SECRET });

export default defineConfig({
  testDir: "e2e",
  // One at a time: the instances share a database each, and the tests are quick.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  webServer: [
    instance("open", 3201, { ...on(3201), FJORD_AUTH_SIGNUP: "open" }),
    instance("closed", 3202, on(3202)),
    instance("off", 3203, {}),
  ],
  projects: [
    { name: "open", testMatch: "**/*.open.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3201" } },
    { name: "closed", testMatch: "**/*.closed.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3202" } },
    { name: "off", testMatch: "**/*.off.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3203" } },
  ],
});
