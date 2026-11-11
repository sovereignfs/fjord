import { describe, expect, it } from 'vitest';
import { offlinePage } from './offline';

describe('the offline page', () => {
  it('is one document with no script and nothing that is not this origin, and its style has the nonce it was asked for', () => {
    const html = offlinePage('NONCE123+/=');
    expect(html).toContain('<style nonce="NONCE123+/=">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(?:href|src)="(?!\/)/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('has no literal colour: the browser follows the light or dark setting', () => {
    expect(offlinePage('n')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it('cannot be made to carry markup through the nonce', () => {
    const html = offlinePage('"><script>alert(1)</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('"><');
  });

  it('is still a page with no nonce', () => {
    expect(offlinePage(undefined)).toContain('<style>');
  });
});
