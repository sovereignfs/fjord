import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DocIndex } from "../browse/doc-index";
import type { Source } from "../browse/ids";
import { readRepository } from "../browse/repository";
import { TreeCache } from "../browse/tree-cache";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { type OpenPublishedDeps, openPublished } from "./open";
import { PublicationService } from "./publications";

/**
 * Opening a published page: the real format module and databases, an in-memory host for the owner's repository. What matters is who is let in (anyone with a live
 * token, and nothing else), what they are shown (the title and the rendered body, never the header or the path), that the saved version is what is shown, and that
 * an ended address, a deleted Doc and a Doc of an encrypted vault are all just nothing.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const PLAIN = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const SECRET = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: "none", armor: false }, fileNaming: "plain" });
const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";
const doc = (id: string, title: string, body = "The plan.") => `---\nid: ${id}\ntitle: ${title}\nx-secret: not for the reader\n---\n\n# ${title}\n\n${body}\n`;

let database: Database;
let publications: PublicationService;
const tables = () => [database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication, database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex, database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache];

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  publications = new PublicationService(database);
});
afterAll(async () => database?.close());
beforeEach(async () => {
  for (const table of tables()) await dbRun(database, sql`DELETE FROM ${table}`);
});

function setup(files: Record<string, string | null>) {
  const host = new MemoryProvider();
  host.createRepository(REF);
  host.seed(REF, { "Notes/fjord.vault.json": PLAIN, ...files });
  const deps: OpenPublishedDeps = {
    publications,
    sourceOf: async (connectionId): Promise<Source | undefined> => {
      if (connectionId !== 1) return undefined;
      const read = await readRepository({ provider: host, cache: new TreeCache(database), format: fjord() }, { id: 1, ref: REF, branch: "main" });
      return { connectionId, ref: REF, read, provider: host };
    },
    index: new DocIndex(database),
    format: fjord(),
  };
  return { host, deps };
}

describe.skipIf(!available)(`opening a published page (${leg})`, () => {
  it("shows the title and the rendered body to anyone with the address, and nothing of the header or the path", async () => {
    const { deps } = setup({ "Notes/Plans/Plan.md": doc(ID, "Q4 plan", "A *plan*, with <script>alert(1)</script> in it.") });
    const { token } = await publications.publish(1, ID, "alice");
    const page = await openPublished(deps, token);
    expect(page?.title).toBe("Q4 plan");
    expect(page?.html).toContain("<h1>Q4 plan</h1>");
    expect(page?.html).toContain("<em>plan</em>");
    expect(page?.html).toContain("&lt;script&gt;");
    expect(JSON.stringify(page)).not.toMatch(/<script|x-secret|not for the reader|Plans|Plan\.md/);
  });

  it("shows the saved version as it is now, and follows the Doc when it is moved or edited elsewhere", async () => {
    const { deps, host } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan", "First.") });
    const { token } = await publications.publish(1, ID, "alice");
    expect((await openPublished(deps, token))?.html).toContain("First.");
    host.seed(REF, { "Notes/Plan.md": null, "Notes/Archive/Plan.md": doc(ID, "Q4 plan, final", "Second.") });
    const again = await openPublished(deps, token);
    expect(again?.title).toBe("Q4 plan, final");
    expect(again?.html).toContain("Second.");
  });

  it("shows nothing once the address is ended, for a token never made or not one, or once the Doc is gone", async () => {
    const { deps, host } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan") });
    const { token } = await publications.publish(1, ID, "alice");
    for (const bad of ["", "x", "a".repeat(43), "a".repeat(44), `${token}.`, token.toUpperCase()]) expect(await openPublished(deps, bad), bad).toBeUndefined();
    host.seed(REF, { "Notes/Plan.md": null });
    expect(await openPublished(deps, token)).toBeUndefined();
    host.seed(REF, { "Notes/Plan.md": doc(ID, "Q4 plan") });
    expect(await openPublished(deps, token)).toMatchObject({ title: "Q4 plan" });
    await publications.unpublish(1, ID);
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("shows nothing for a Doc in an encrypted vault, whatever was recorded: the server has no key", async () => {
    const { deps } = setup({ "Secret/fjord.vault.json": SECRET, "Secret/recipients.txt": "age1x\n", "Secret/Plan.md.age": "age-encryption.org/v1\n" });
    const { token } = await publications.publish(1, ID, "alice");
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("shows a copy that was handed over, without reading the repository, rendered the same way and as safely", async () => {
    const { deps } = setup({});
    const { token } = await publications.publishCopy(1, "Secret/Plan.md.age", "alice", { title: "Secret plan", body: "# Secret plan\n\nSee <script>alert(1)</script> and [x](javascript:alert(1)).\n" });
    const page = await openPublished({ ...deps, sourceOf: async () => undefined }, token);
    expect(page?.title).toBe("Secret plan");
    expect(page?.html).toContain("<h1>Secret plan</h1>");
    expect(page?.html).not.toMatch(/<script|<a /);
    await publications.unpublish(1, "file:Secret/Plan.md.age");
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("shows nothing when the repository cannot be read", async () => {
    const { deps } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan") });
    const { token } = await publications.publish(2, ID, "alice");
    expect(await openPublished(deps, token)).toBeUndefined();
  });
});
