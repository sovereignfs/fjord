import { randomBytes } from "node:crypto";
import { sovereignAuthConfig } from "../auth/server";
import { Keyring } from "../crypto/keyring";
import { encryptionKeyring } from "../crypto/server";
import { CredentialStore } from "../crypto/store";
import { getAuthDatabase, getDatabase } from "../db/boot";
import { ConnectionService } from "../connections/service";
import { RateLimiter } from "../limits/rate";
import type { NoticeDeps } from "./http";
import { People } from "./people";
import { sdkVerifiers, seenBy } from "./verifiers";

/**
 * What the routes for Sovereign's notices are handed (`http.ts`): the SDK's verifiers for this instance's settings, the people to act on, and
 * the limit on how many requests are taken. Undefined when Sovereign sign-in is not set up, when there is nothing to hear from, and the
 * routes answer 404. Never for a test, which makes its own.
 */
const KEY = Symbol.for("fjord.sovereign-notices");
type Holder = { [KEY]?: Promise<NoticeDeps | undefined> };

export function noticeDeps(): Promise<NoticeDeps | undefined> {
  const store = globalThis as Holder;
  // Made once, so that the limiter's counts are one process's and its sweep of old rows runs.
  store[KEY] ??= make();
  return store[KEY];
}

async function make(): Promise<NoticeDeps | undefined> {
  const sovereign = sovereignAuthConfig();
  if (!sovereign) return undefined;
  const app = await getDatabase();
  const limiter = new RateLimiter(app);
  // Removing a repository needs no key, and a deletion must not fail because the operator has since taken the key away, so without one the
  // store is given a key that is never used (nothing is sealed or opened here).
  const credentials = new CredentialStore(app, encryptionKeyring() ?? new Keyring(randomBytes(32)));
  const connections = new ConnectionService({
    database: app,
    credentials,
    github: () => {
      throw new Error("removing a repository does not reach its git host");
    },
  });
  return {
    verify: sdkVerifiers({ coreUrl: sovereign.issuer, clientId: sovereign.clientId, seen: seenBy(limiter) }),
    people: new People({ app, auth: await getAuthDatabase(), connections }),
    limiter,
    log: (line) => console.error(line),
  };
}
