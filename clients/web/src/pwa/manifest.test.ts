import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifestRoute from '../../app/manifest';
import { SURFACE_DARK, SURFACE_LIGHT, manifest } from './manifest';

const root = join(__dirname, '..', '..');
const public_ = (path: string) => readFileSync(join(root, 'public', path.replace(/^\//, '')));

/** The width and height written in a PNG's header (its IHDR chunk), which is what an installer reads the icon's size from. */
const pngSize = (bytes: Buffer) => ({
  signature: bytes.subarray(0, 8).toString('hex'),
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

describe('the web app manifest', () => {
  const m = manifest();

  it('is what app/manifest.ts serves', () => {
    expect(manifestRoute).toBe(manifest);
  });

  it('has what a browser needs to offer to install: a name, a start address inside its scope, a standalone display and icons of 192 and 512 pixels', () => {
    expect(m.name).toBe('Fjord');
    expect(m.short_name).toBe('Fjord');
    expect(m.display).toBe('standalone');
    expect(m.scope).toBe('/');
    expect(m.start_url?.startsWith(m.scope!)).toBe(true);
    const sizes = (m.icons ?? []).filter((i) => i.type === 'image/png').map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('has a maskable icon apart from the ones for `any`, so that none is cut to a shape it was not drawn for', () => {
    const purposes = (m.icons ?? []).map((icon) => icon.purpose);
    expect(purposes).toContain('maskable');
    expect(
      (m.icons ?? []).filter((icon) => icon.purpose?.includes('any') && icon.purpose !== 'any'),
    ).toEqual([]);
  });

  it('names icons that exist and are the size they say they are', () => {
    for (const icon of m.icons ?? []) {
      if (icon.type !== 'image/png') continue;
      const { signature, width, height } = pngSize(public_(icon.src));
      expect(signature, icon.src).toBe('89504e470d0a1a0a');
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
    expect(pngSize(public_('/icons/apple-touch-icon.png'))).toMatchObject({
      width: 180,
      height: 180,
    });
  });

  it('uses the surface colours of the design system, which the page does as well', () => {
    expect([m.background_color, m.theme_color]).toEqual([SURFACE_LIGHT, SURFACE_LIGHT]);
    const tokens = readFileSync(
      join(root, 'node_modules/@sovereignfs/ui/dist/tokens/primitives.css'),
      'utf8',
    );
    expect(tokens).toContain(`--sv-white: ${SURFACE_LIGHT}`);
    expect(tokens).toContain(`--sv-grey-950: ${SURFACE_DARK}`);
  });

  it('has shortcuts that stay inside its scope', () => {
    for (const shortcut of m.shortcuts ?? []) expect(shortcut.url.startsWith('/')).toBe(true);
  });
});
