import { type Table, is } from "drizzle-orm";
import { PgTable, getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { SQLiteTable, getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as pgSchema from "./schema/postgres";
import * as pgAuth from "./schema/postgres/auth";
import * as pgColumns from "./schema/postgres/columns";
import * as sqliteSchema from "./schema/sqlite";
import * as sqliteAuth from "./schema/sqlite/auth";
import * as sqliteColumns from "./schema/sqlite/columns";

/**
 * The two dialects' schemas must declare the same tables, columns and indexes
 * (DESIGN.md §14). They are written twice, because the dialect builders are
 * different libraries, so this is what stops one from drifting from the other.
 */

interface TableShape {
  columns: Record<string, string>;
  indexes: Record<string, string>;
}
type Shape = Record<string, TableShape>;

/** `name -> portable description`. A column's type class is Drizzle's `dataType` (number, string, boolean, json, bigint…), which is what the app sees. */
function shapeOf(tables: Table[], config: (table: never) => { name: string; columns: unknown[]; indexes: unknown[] }): Shape {
  const shape: Shape = {};
  for (const table of tables) {
    const { name, columns, indexes } = config(table as never);
    shape[name] = {
      columns: Object.fromEntries(
        (columns as { name: string; dataType: string; notNull: boolean; primary: boolean; hasDefault: boolean }[])
          .map((c) => [c.name, `${c.dataType}${c.notNull ? " not null" : ""}${c.primary ? " primary" : ""}${c.hasDefault ? " default" : ""}`])
          .sort(),
      ),
      indexes: Object.fromEntries(
        (indexes as { config: { name: string; unique: boolean; columns: { name: string }[] } }[])
          .map((i) => [i.config.name, `${i.config.unique ? "unique " : ""}${i.config.columns.map((c) => c.name).join(",")}`])
          .sort(),
      ),
    };
  }
  return shape;
}

// Both stores' tables: the app's and better-auth's. The schema modules export tables, and
// for PostgreSQL the schema objects too, which are not tables.
const sqliteShape = () =>
  shapeOf(
    [...Object.values(sqliteSchema), ...Object.values(sqliteAuth)].filter((v) => is(v, SQLiteTable)) as unknown as Table[],
    sqliteTableConfig as never,
  );
const pgShape = () =>
  shapeOf([...Object.values(pgSchema), ...Object.values(pgAuth)].filter((v) => is(v, PgTable)) as unknown as Table[], pgTableConfig as never);

/** Every way two shapes differ, as sentences. Empty means they match. */
export function differences(sqlite: Shape, postgres: Shape): string[] {
  const out: string[] = [];
  for (const table of new Set([...Object.keys(sqlite), ...Object.keys(postgres)])) {
    const a = sqlite[table];
    const b = postgres[table];
    if (!a || !b) {
      out.push(`table "${table}" exists only on ${a ? "sqlite" : "postgres"}`);
      continue;
    }
    for (const [kind, label] of [["columns", "column"], ["indexes", "index"]] as const) {
      for (const name of new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])])) {
        const x = a[kind][name];
        const y = b[kind][name];
        if (x === undefined || y === undefined) out.push(`${label} "${table}.${name}" exists only on ${x === undefined ? "postgres" : "sqlite"}`);
        else if (x !== y) out.push(`${label} "${table}.${name}" differs: sqlite "${x}", postgres "${y}"`);
      }
    }
  }
  return out;
}

describe("schema parity", () => {
  it("declares the same tables, columns and indexes on SQLite and PostgreSQL", () => {
    expect(differences(sqliteShape(), pgShape())).toEqual([]);
  });

  it("declares at least one table on each, so the comparison compares something", () => {
    expect(Object.keys(sqliteShape()).length).toBeGreaterThan(0);
    expect(Object.keys(pgShape())).toEqual(Object.keys(sqliteShape()));
  });

  it("offers the same column vocabulary on both", () => {
    expect(Object.keys(pgColumns).sort()).toEqual(Object.keys(sqliteColumns).sort());
  });

  // The test above is only worth anything if it can fail, so show that it does.
  describe("noticing a difference", () => {
    const base = (): Shape => ({ event: { columns: { id: "number not null primary", kind: "string not null" }, indexes: { event_kind_idx: "kind" } } });

    it("a column on one side only", () => {
      const sqlite = base();
      sqlite.event!.columns.extra = "string";
      expect(differences(sqlite, base())).toEqual(['column "event.extra" exists only on sqlite']);
      expect(differences(base(), sqlite)).toEqual(['column "event.extra" exists only on postgres']);
    });

    it("a column of a different kind or nullability", () => {
      const postgres = base();
      postgres.event!.columns.kind = "string";
      expect(differences(base(), postgres)).toEqual(['column "event.kind" differs: sqlite "string not null", postgres "string"']);
    });

    it("an index on one side only, or on different columns", () => {
      const postgres = base();
      postgres.event!.indexes.event_kind_idx = "kind,id";
      expect(differences(base(), postgres)).toHaveLength(1);
      delete postgres.event!.indexes.event_kind_idx;
      expect(differences(base(), postgres)).toEqual(['index "event.event_kind_idx" exists only on sqlite']);
    });

    it("a table on one side only", () => {
      expect(differences(base(), {})).toEqual(['table "event" exists only on sqlite']);
    });
  });
});
