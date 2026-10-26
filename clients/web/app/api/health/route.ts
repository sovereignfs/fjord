import { sql } from "drizzle-orm";
import { getDatabase } from "../../../src/db/boot";
import { dbGet } from "../../../src/db/exec";
import { fjord } from "../../../src/format/wasm";

// Answers from the live database every time, never from a cache.
export const dynamic = "force-dynamic";

/**
 * Whether this instance is up and can reach its database. For a load balancer or a
 * container health check, and for CI to see that a fresh instance booted. It says
 * which database it is on, and whether the format module (`src/format/`) loads, and nothing
 * that would help an attacker. A module that does not load is not "down": sign-in works without
 * it, and only reading a repository does not. It is said so that a deployment which lacks it is
 * found by looking here and not by the first person to open a repository.
 */
export async function GET(): Promise<Response> {
  try {
    const database = await getDatabase();
    await dbGet(database, sql`SELECT 1 AS ok`);
    return Response.json({
      status: "ok",
      database: { dialect: database.dialect, ...(database.dialect === "sqlite" ? { form: database.form } : {}) },
      format: formatState(),
    });
  } catch (error) {
    // The message may name a host; it goes to the log, not to whoever asked.
    console.error("[fjord] health check failed:", error);
    return Response.json({ status: "error" }, { status: 503 });
  }
}

function formatState(): "ok" | "unavailable" {
  try {
    fjord().version;
    return "ok";
  } catch {
    return "unavailable";
  }
}
