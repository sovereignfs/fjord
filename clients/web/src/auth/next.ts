/**
 * Where a person was going when they were asked to sign in, so that signing in takes them there and not to their default repository: a link to a
 * document, followed while signed out, is the usual way to arrive. It is carried in an address (`/sign-in?next=`), so anyone can write one: only a path of
 * this site is taken, never another site's (`//evil.example`, `/\\evil.example`), and nothing that holds a token.
 */
export const PATH_HEADER = 'x-fjord-path';

const NOWHERE = new Set(['/', '/home', '/open']);

export function safeNext(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  // A path of this site: one slash and then not another, nor the backslash a browser reads as one, nor a control character (a line break ends a header).
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  for (let at = 0; at < value.length; at++)
    if (value.charCodeAt(at) <= 0x1f || value.charCodeAt(at) === 0x7f) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, 'http://fjord.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'http://fjord.invalid' || parsed.searchParams.has('token')) return null;
  const path = parsed.pathname;
  if (
    NOWHERE.has(path) ||
    path.startsWith('/sign-') ||
    path.startsWith('/api/') ||
    path === '/forgot-password' ||
    path === '/reset-password'
  )
    return null;
  return path + parsed.search;
}

/** The sign-in page's address, for someone who was on their way to `from`. */
export function signInAddress(from: string | null | undefined): string {
  const next = safeNext(from);
  return next === null ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;
}

/** Kept for the second step of sign-in, which better-auth's client opens by itself and so cannot be told. */
const STEP_KEY = 'fjord:sign-in-next';

export function rememberNext(next: string | null): void {
  try {
    if (next === null) window.sessionStorage.removeItem(STEP_KEY);
    else window.sessionStorage.setItem(STEP_KEY, next);
  } catch {
    // No storage: the person lands on their default repository, as they would have.
  }
}

export function recallNext(): string | null {
  try {
    const next = safeNext(window.sessionStorage.getItem(STEP_KEY));
    window.sessionStorage.removeItem(STEP_KEY);
    return next;
  } catch {
    return null;
  }
}
