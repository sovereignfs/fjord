import { authConfig, getSession } from '../auth/server';
import type { Caller, Deps } from './preview-http';
import { previewDeps } from './preview-server';

/** Who is calling, and what `preview-http.ts` needs to answer them. Null when the instance has no sign-in at all, in which case the route is not there (404). */
export async function previewContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return {
    caller: session
      ? { accountId: session.user.id, name: session.user.name, email: session.user.email }
      : null,
    deps: previewDeps(config.url),
  };
}
