import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { KEEP_MS, RateLimiter, takeAll } from "./rate";

/** Rate limits counted in the database (ROADMAP 1d.4), over the real databases. */
const { leg } = testTarget();
let database: Database;
let clock = 1_800_000_000_000;
let limiter: RateLimiter;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${database.dialect === "postgres" ? postgresSchema.rateBucket : sqliteSchema.rateBucket}`);
  clock = 1_800_000_000_000;
  limiter = new RateLimiter(database, () => clock);
});

const MINUTE = { limit: 3, windowMs: 60_000 };

describe(`counting (${leg})`, () => {
  it("lets through as many as the limit, and refuses the rest, saying how long to wait", async () => {
    for (let i = 0; i < 3; i++) expect(await limiter.take("a", MINUTE), `take ${i}`).toEqual({ ok: true });
    clock += 20_000;
    expect(await limiter.take("a", MINUTE)).toEqual({ ok: false, retryAfterMs: 40_000 });
  });

  it("starts again when the window is over, from the first count after it", async () => {
    for (let i = 0; i < 5; i++) await limiter.take("a", MINUTE);
    clock += 59_999;
    expect((await limiter.take("a", MINUTE)).ok).toBe(false);
    clock += 1;
    expect(await limiter.take("a", MINUTE)).toEqual({ ok: true });
    for (let i = 0; i < 2; i++) expect((await limiter.take("a", MINUTE)).ok).toBe(true);
    expect((await limiter.take("a", MINUTE)).ok).toBe(false);
  });

  it("counts a refused try too, so that asking again at once is no nearer", async () => {
    for (let i = 0; i < 3; i++) await limiter.take("a", MINUTE);
    for (let i = 0; i < 50; i++) await limiter.take("a", MINUTE);
    clock += 60_000;
    expect(await limiter.take("a", MINUTE)).toEqual({ ok: true });
  });

  it("keeps each holder's and each rule's count apart", async () => {
    for (let i = 0; i < 4; i++) await limiter.take("a", MINUTE);
    expect((await limiter.take("a", MINUTE)).ok).toBe(false);
    expect((await limiter.take("b", MINUTE)).ok).toBe(true);
    expect((await limiter.take("a:hour", { limit: 100, windowMs: 3_600_000 })).ok).toBe(true);
  });

  it("is exact when many ask at once: no more than the limit are let through", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter.take("busy", { limit: 10, windowMs: 60_000 })));
    expect(results.filter((result) => result.ok)).toHaveLength(10);
  });

  it("counts against each rule in turn and stops at the first that refuses", async () => {
    const entries = [
      { key: "x:min", rule: { limit: 2, windowMs: 60_000 } },
      { key: "x:hour", rule: { limit: 3, windowMs: 3_600_000 } },
    ];
    expect(await limiter.takeAll(entries)).toEqual({ ok: true });
    expect(await limiter.takeAll(entries)).toEqual({ ok: true });
    expect((await limiter.takeAll(entries)).ok).toBe(false); // the minute's
    clock += 61_000;
    expect(await limiter.takeAll(entries)).toEqual({ ok: true }); // the hour's third
    expect(await limiter.takeAll(entries)).toMatchObject({ ok: false }); // the hour's fourth
  });

  it("is no limit at all where there is no limiter", async () => {
    expect(await takeAll(undefined, [{ key: "a", rule: { limit: 0, windowMs: 1 } }])).toEqual({ ok: true });
    expect(await takeAll(limiter, [{ key: "a", rule: { limit: 0, windowMs: 1000 } }])).toMatchObject({ ok: false });
  });
});

describe(`forgetting what is long over (${leg})`, () => {
  it("sweeps the rows whose window began more than a day ago, and no others", async () => {
    await limiter.take("old", MINUTE);
    clock += KEEP_MS + 1;
    await limiter.take("new", MINUTE);
    await limiter.sweep();
    expect(await limiter.rows()).toBe(1);
    expect((await limiter.take("new", MINUTE)).ok).toBe(true);
  });

  it("does so now and then by itself", async () => {
    await limiter.take("old", MINUTE);
    clock += KEEP_MS + 1;
    for (let i = 0; i < 200; i++) await limiter.take("busy", { limit: 1000, windowMs: 60_000 });
    expect(await limiter.rows()).toBe(1);
  });
});
