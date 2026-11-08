import type { BuildCheck, BuildStatus } from './types';

/**
 * The state of a commit's build from the checks the host reported, whatever the host: any failure is a failure, else anything
 * not done is pending, else it is a success; and no check at all is `none` (a host that reports nothing is not a build in progress).
 */
export function summarise(
  commit: string,
  checks: BuildCheck[],
  siteUrl?: string | undefined,
): BuildStatus {
  const state =
    checks.length === 0
      ? 'none'
      : checks.some((check) => check.state === 'failure')
        ? 'failure'
        : checks.some((check) => check.state === 'pending')
          ? 'pending'
          : 'success';
  return { commit, state, checks, ...(siteUrl !== undefined ? { siteUrl } : {}) };
}

/**
 * `url` as the host gave it if it is one to show as a link, and nothing otherwise: an `http` or `https` address. A host's report is not trusted
 * to be one (a `javascript:` address in a link is a script), and an address that is one is not rewritten.
 */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > 2000) return undefined;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}
