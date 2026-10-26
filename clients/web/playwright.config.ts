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
 * Five instances of the app run, each on a file database of its own, because what is under
 * test differs by how the instance is set up:
 *   open       local sign-in on, anyone may sign up, repositories can be connected (e2e/*.open.spec.ts)
 *   closed     local sign-in on, only the first account    (e2e/*.closed.spec.ts)
 *   off        no sign-in switched on                      (e2e/*.off.spec.ts)
 *   sovereign  Sovereign sign-in only, first account only  (e2e/*.sovereign.spec.ts)
 *   both       local and Sovereign, anyone may sign up     (e2e/*.both.spec.ts)
 *
 * `open` connects repositories to a fake GitHub (src/providers/testing/fake-github.ts, whose storage
 * is a real git repository) that its spec starts on port 3192; the instance has an encryption key
 * for the tokens, the others do not.
 *
 * The last two sign in through a fake Sovereign (src/auth/testing/fake-sovereign.ts), run by
 * e2e/fake-sovereign-server.ts on port 3190, with a control port at 3191 that says who the next
 * person to sign in is.
 *
 * The secret below is for these throwaway instances only.
 */
const data = mkdtempSync(join(tmpdir(), "fjord-e2e-"));
const SECRET = "e2e-only-secret-not-for-anything-real-0123456789";

// Next reads `.env.local` and does not override what is already set, so a developer's own
// settings there (a real Sovereign, say) would reach these instances. Setting a name, even to
// nothing, keeps it out: an empty value is "not set" to the app.
const BLANK = Object.fromEntries(
  ["FJORD_URL", "FJORD_AUTH_LOCAL", "FJORD_AUTH_SECRET", "FJORD_AUTH_SIGNUP", "FJORD_AUTH_SOVEREIGN_ISSUER", "FJORD_AUTH_SOVEREIGN_CLIENT_ID", "FJORD_AUTH_SOVEREIGN_CLIENT_SECRET", "FJORD_AUTH_SOVEREIGN_CLIENT_SECRET_FILE", "FJORD_AUTH_SECRET_FILE", "SMTP_HOST", "FJORD_ENCRYPTION_KEY", "FJORD_ENCRYPTION_KEY_FILE", "FJORD_ENCRYPTION_KEY_PREVIOUS", "FJORD_GITHUB_API_URL", "FJORD_WASM_DIR"].map((name) => [name, ""]),
);

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
    env: { ...BLANK, DB_DIALECT: "sqlite", SQLITE_URL: `file:${join(directory, "fjord.db")}`, ...env },
  };
};

const on = (port: number) => ({ FJORD_AUTH_LOCAL: "1", FJORD_URL: `http://localhost:${port}`, FJORD_AUTH_SECRET: SECRET });

/** The fake Sovereign these instances sign in through, with the settings that register their client. */
const sovereign = {
  FJORD_AUTH_SOVEREIGN_ISSUER: "http://localhost:3190/api/auth",
  FJORD_AUTH_SOVEREIGN_CLIENT_ID: "fjord-e2e-client",
  FJORD_AUTH_SOVEREIGN_CLIENT_SECRET: "fjord-e2e-secret",
};

export default defineConfig({
  testDir: "e2e",
  // One at a time: the instances share a database each, and the tests are quick.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  webServer: [
    // First, so that it is up when the instances that sign in through it start and discover it.
    { command: "node e2e/fake-sovereign-server.ts", url: "http://localhost:3191/health", timeout: 30_000, reuseExistingServer: false },
    instance("open", 3201, {
      ...on(3201),
      FJORD_AUTH_SIGNUP: "open",
      FJORD_ENCRYPTION_KEY: "ZTJlLW9ubHkta2V5LW5vdC1mb3ItYW55dGhpbmchISE=",
      FJORD_GITHUB_API_URL: "http://localhost:3192",
    }),
    instance("closed", 3202, on(3202)),
    instance("off", 3203, {}),
    instance("sovereign", 3204, { FJORD_URL: "http://localhost:3204", FJORD_AUTH_SECRET: SECRET, ...sovereign }),
    instance("both", 3205, { ...on(3205), FJORD_AUTH_SIGNUP: "open", ...sovereign }),
  ],
  projects: [
    { name: "open", testMatch: "**/*.open.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3201" } },
    { name: "closed", testMatch: "**/*.closed.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3202" } },
    { name: "off", testMatch: "**/*.off.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3203" } },
    { name: "sovereign", testMatch: "**/*.sovereign.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3204" } },
    { name: "both", testMatch: "**/*.both.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3205" } },
  ],
});
