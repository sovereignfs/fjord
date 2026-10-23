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
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FJORD_SKIP_DATABASE === "1") return;
  const { describeAuth } = await import("./src/auth/config");
  const { authConfig } = await import("./src/auth/server");
  console.info(`[fjord] auth: ${describeAuth(authConfig())}`);
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
}
