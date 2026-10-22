import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/postgres/index.ts",
  out: "./migrations/postgres",
  dialect: "postgresql",
});
