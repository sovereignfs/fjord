import { authConfig, getSession } from "../auth/server";
import type { Caller, Deps, RecipientsDeps } from "./http";
import { readCiphertext, readVaultRecipients } from "./server";

/** Who is calling, and what `http.ts` needs. Null when the instance has no sign-in, in which case there are no connections and the route is not there. */
export async function ciphertextContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return { caller: session ? { accountId: session.user.id } : null, deps: { read: readCiphertext } };
}

/** The same for the recipients route. */
export async function recipientsContext(): Promise<{ caller: Caller | null; deps: RecipientsDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return { caller: session ? { accountId: session.user.id } : null, deps: { read: readVaultRecipients } };
}
