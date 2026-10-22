import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./client";
import { appendEvent, eventsAfter, latestEventId, pruneEvents } from "./events";
import { dbRun } from "./exec";
import { runMigrations } from "./migrate";
import * as postgresSchema from "./schema/postgres";
import * as sqliteSchema from "./schema/sqlite";
import { freshDatabase, testTarget } from "./test-support";

const { leg } = testTarget();
let database: Database;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  const table = database.dialect === "postgres" ? postgresSchema.event : sqliteSchema.event;
  await dbRun(database, sql`DELETE FROM ${table}`);
});

describe(`events (${leg})`, () => {
  it("appends an event and returns it, with numbers where numbers belong", async () => {
    const event = await appendEvent(database, { kind: "upstream-changed", subject: "conn1:Notes/a.md" }, 1_800_000_000_123);
    expect(event).toEqual({ id: expect.any(Number), kind: "upstream-changed", subject: "conn1:Notes/a.md", createdAt: 1_800_000_000_123 });
    expect(typeof event.id).toBe("number");
    expect(typeof event.createdAt).toBe("number");
    expect(event.id).toBeGreaterThan(0);
  });

  it("gives each event a higher id than the last", async () => {
    const a = await appendEvent(database, { kind: "k", subject: "1" });
    const b = await appendEvent(database, { kind: "k", subject: "2" });
    expect(b.id).toBeGreaterThan(a.id);
  });

  it("reads what came after a cursor, oldest first", async () => {
    const [a, b, c] = [
      await appendEvent(database, { kind: "k", subject: "a" }),
      await appendEvent(database, { kind: "k", subject: "b" }),
      await appendEvent(database, { kind: "k", subject: "c" }),
    ];
    expect((await eventsAfter(database, 0)).map((e) => e.subject)).toEqual(["a", "b", "c"]);
    expect((await eventsAfter(database, a.id)).map((e) => e.subject)).toEqual(["b", "c"]);
    expect(await eventsAfter(database, c.id)).toEqual([]);
    expect((await eventsAfter(database, 0, 2)).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it("knows the latest id, and 0 when there is none", async () => {
    expect(await latestEventId(database)).toBe(0);
    await appendEvent(database, { kind: "k", subject: "a" });
    const last = await appendEvent(database, { kind: "k", subject: "b" });
    expect(await latestEventId(database)).toBe(last.id);
  });

  it("prunes events older than a time and says how many went", async () => {
    await appendEvent(database, { kind: "k", subject: "old1" }, 1000);
    await appendEvent(database, { kind: "k", subject: "old2" }, 2000);
    await appendEvent(database, { kind: "k", subject: "new" }, 5000);

    expect(await pruneEvents(database, 3000)).toBe(2);
    expect((await eventsAfter(database, 0)).map((e) => e.subject)).toEqual(["new"]);
    expect(await pruneEvents(database, 3000)).toBe(0);
  });

  it("does not hand ids back after pruning, so a reader's cursor stays valid", async () => {
    const a = await appendEvent(database, { kind: "k", subject: "a" }, 1);
    await pruneEvents(database, 10);
    const b = await appendEvent(database, { kind: "k", subject: "b" });
    expect(b.id).toBeGreaterThan(a.id);
  });

  it("gives concurrent appends distinct ids", async () => {
    const events = await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvent(database, { kind: "k", subject: String(i) })));
    expect(new Set(events.map((e) => e.id)).size).toBe(20);
  });

  it("stores text as given, quotes, SQL and all", async () => {
    const subject = `x'); DROP TABLE event; -- "quoted" ünïcödé 日本語`;
    const event = await appendEvent(database, { kind: "k", subject });
    expect(event.subject).toBe(subject);
    expect((await eventsAfter(database, 0))[0]?.subject).toBe(subject);
  });
});
