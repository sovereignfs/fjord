/**
 * Runs once when the server starts. The database is brought up here, so a server that cannot
 * reach or migrate its database never starts serving; see `src/db/boot.ts`. The sign-in
 * settings are checked here too, so a bad one stops the server at start-up and says which
 * setting, instead of failing on the first person to sign in.
 *
 * Not during `next build`: a build has no database, and `register` is not called there.
 * Set FJORD_SKIP_DATABASE=1 to start without one (a type-check or a static export).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FJORD_SKIP_DATABASE === "1") return;
  const { describeAuth } = await import("./src/auth/config");
  const { authConfig } = await import("./src/auth/server");
  console.info(`[fjord] auth: ${describeAuth(authConfig())}`);
  const { getDatabase } = await import("./src/db/boot");
  await getDatabase();
}
