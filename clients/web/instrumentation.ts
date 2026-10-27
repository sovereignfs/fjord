/**
 * Runs once when the server starts. The database is brought up here, so a server that cannot
 * reach or migrate its database never starts serving; see `src/db/boot.ts`. The sign-in
 * settings and the instance's encryption key are checked here too, so a bad one stops the
 * server at start-up and says which setting, instead of failing on the first person to sign in
 * or connect a repository; and stored credentials are wrapped under the current key (a
 * rotation, `src/crypto/store.ts`).
 *
 * Not during `next build`: a build has no database, and `register` is not called there.
 * Set FJORD_SKIP_DATABASE=1 to start without one (a type-check or a static export).
 *
 * A server that fails here stops, whatever started it. `next start` exits on its own, but the
 * self-contained `server.js` the container image runs logs the failure and carries on serving,
 * every request an error: so in production the process exits, with the reason in its output,
 * and a container manager sees a container that did not start instead of one that is merely
 * unhealthy (deploy/README.md).
 */
export async function register(): Promise<void> {
  // These two guards stay first, with everything else under them in this one function: the bundler removes
  // what follows them from the Edge build, which must not see (and cannot build) the database client.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Before anything can print: a share token in an address is never in a log line (ROADMAP 1c.4).
  const { installLogRedaction } = await import("./src/sharing/redact");
  installLogRedaction();
  if (process.env.FJORD_SKIP_DATABASE === "1") return;
  try {
    const { describeAuth } = await import("./src/auth/config");
    const { authConfig } = await import("./src/auth/server");
    console.info(`[fjord] auth: ${describeAuth(authConfig())}`);
    const { resolveGitHubApiUrl } = await import("./src/connections/config");
    resolveGitHubApiUrl(process.env);
    const { describeEncryption } = await import("./src/crypto/config");
    const { encryptionKeyring } = await import("./src/crypto/server");
    const { prepareCredentials } = await import("./src/crypto/store");
    const keyring = encryptionKeyring();
    console.info(`[fjord] credentials: ${describeEncryption(keyring)}`);
    const { getDatabase } = await import("./src/db/boot");
    const database = await getDatabase();
    const status = await prepareCredentials(database, keyring);
    if (status.rewrapped > 0) console.info(`[fjord] credentials: wrapped ${status.rewrapped} under the current key; the previous key can now be removed`);
    else if (keyring && keyring.previousIds.length > 0) console.info("[fjord] credentials: nothing is under a previous key any more; FJORD_ENCRYPTION_KEY_PREVIOUS can be removed");
  } catch (error) {
    if (process.env.NODE_ENV !== "production") throw error;
    console.error("[fjord] cannot start:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
