/**
 * Runs once when the server starts. The database is brought up here, so a server
 * that cannot reach or migrate its database never starts serving; see `src/db/boot.ts`.
 *
 * Not during `next build`: a build has no database, and `register` is not called there.
 * Set FJORD_SKIP_DATABASE=1 to start without one (a type-check or a static export).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FJORD_SKIP_DATABASE === "1") return;
  const { getDatabase } = await import("./src/db/boot");
  await getDatabase();
}
