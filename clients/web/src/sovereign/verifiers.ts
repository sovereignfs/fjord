import { verifyAccountDeletedToken, verifyLogoutToken } from '@sovereignfs/sdk';
import type { Limiter } from '../limits/rate';
import type { NoticeVerifiers } from './http';

/**
 * Sovereign's notices are checked by `@sovereignfs/sdk` (its `verifyLogoutToken` and `verifyAccountDeletedToken`), which holds the rules of
 * its sign-in contract so that no app writes them a second time: type, signature against core's keys, issuer, audience, age, event, `jti`,
 * no `nonce`. This is the one file that imports it, so that everything else is tested with stand-ins and this is tested against the SDK's
 * own fake core (`verifiers.test.ts`).
 */
export interface VerifierOptions {
  /** Sovereign's address, which is its issuer (`FJORD_CORE_URL`). */
  coreUrl: string;
  /** This app's client at Sovereign (`FJORD_CORE_CLIENT_ID`), which a notice names as its audience. */
  clientId: string;
  seen: (jti: string, expiresAt: number) => Promise<boolean>;
  /** How to reach Sovereign, for a test; by default the platform's `fetch`. */
  fetch?: typeof fetch;
}

export function sdkVerifiers(options: VerifierOptions): NoticeVerifiers {
  return {
    logout: (token) => verifyLogoutToken(token, options),
    accountDeleted: (token) => verifyAccountDeletedToken(token, options),
  };
}

/**
 * Whether a notice was seen before (the SDK's `seen`): its `jti` is counted against a limit of one for as long as the notice could be
 * replayed, in the database that every process shares. The first to ask is let in and every later one is refused, which is "seen before";
 * a notice is good for two minutes, so by the time the window ends it is no longer one the SDK will accept.
 */
export function seenBy(
  limiter: Limiter,
  now: () => number = Date.now,
): (jti: string, expiresAt: number) => Promise<boolean> {
  return async (jti, expiresAt) => {
    const taken = await limiter.take(`sovereign-notice:${jti}`, {
      limit: 1,
      windowMs: Math.max(expiresAt - now(), 1000),
    });
    return !taken.ok;
  };
}
