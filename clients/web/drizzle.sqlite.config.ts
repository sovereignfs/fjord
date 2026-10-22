import { defineConfig } from "drizzle-kit";

// Migrations are generated, never pushed (DESIGN.md §14): `pnpm db:generate` runs
// this and its PostgreSQL twin, and the generated SQL is committed and reviewed.
export default defineConfig({
  schema: "./src/db/schema/sqlite/index.ts",
  out: "./migrations/sqlite",
  dialect: "sqlite",
});
