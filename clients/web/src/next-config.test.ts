import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { EMBEDDABLE_SECURITY_HEADERS, SECURITY_HEADERS } from './security/csp';

/** Pages send `Referrer-Policy: no-referrer` (DESIGN.md §12, ROADMAP 1c.4), and the other security headers (§15, ROADMAP 1d.5). */
describe('the headers every page is sent with', () => {
  it('say where a link followed from it came from: nowhere, and the other security headers', async () => {
    const rules = await config.headers?.();
    const referrer = { key: 'Referrer-Policy', value: 'no-referrer' };
    expect(rules).toEqual([
      { source: '/((?!raw/).*)', headers: [referrer, ...SECURITY_HEADERS] },
      { source: '/raw/:path*', headers: [referrer, ...EMBEDDABLE_SECURITY_HEADERS] },
    ]);
  });

  it('forbid framing everywhere but on the sandboxed page this app frames itself, which has all the rest', () => {
    expect(SECURITY_HEADERS.map((header) => header.key)).toContain('X-Frame-Options');
    expect(EMBEDDABLE_SECURITY_HEADERS.map((header) => header.key)).not.toContain(
      'X-Frame-Options',
    );
    expect(EMBEDDABLE_SECURITY_HEADERS).toHaveLength(SECURITY_HEADERS.length - 1);
  });
});
