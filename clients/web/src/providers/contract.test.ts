import { afterAll, beforeAll } from "vitest";
import type { Database } from "../db/client";
import { runMigrations } from "../db/migrate";
import { freshDatabase } from "../db/test-support";
import { providerContract } from "./testing/contract";
import { githubHarness, localHarness, memoryHarness } from "./testing/harnesses";

// The same cases, against all three: GitHub's provider over a fake whose storage is a real git
// repository, the in-memory one, and the one that keeps a repository in this server's own database
// (on whichever of the three database legs the run is for).
providerContract("GitHub, over a git-backed fake", githubHarness, { truncation: true, credentials: true });
providerContract("in memory", memoryHarness, { truncation: true, credentials: false });

let database: Database;
beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
providerContract("on this server (the database)", () => localHarness(database)(), { truncation: true, credentials: false, builds: false });
