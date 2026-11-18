import type { MetadataRoute } from 'next';
import { site } from '../site';

/**
 * The web app manifest: what makes Fjord installable ("Add to Home Screen", "Install app"). It is served at `/manifest.webmanifest` by `app/manifest.ts`.
 *
 * A manifest cannot use the design system's custom properties, so its two colours are the tokens' own values written out: `--sv-color-surface`, which is
 * `--sv-white` in the light theme (and `--sv-grey-950`, `#09090b`, in the dark one, which the pages' `theme-color` metas in `app/layout.tsx` follow).
 * The icons are the app's mark (`app/icon.svg`) as PNG, for the installers that do not take SVG: `any` has the rounded square, `maskable` is full-bleed
 * with the letters inside the safe zone, so a launcher may cut it to any shape.
 */
/** `handle_links` is newer than Next's manifest type, so it is added as a spread, which the type does not check member by member. */
const LINK_CAPTURE = { handle_links: 'preferred' } as const;

export const SURFACE_LIGHT = '#ffffff';
export const SURFACE_DARK = '#09090b';

export function manifest(): MetadataRoute.Manifest {
  return {
    // The identity of the app, apart from the address it is started at: it stays the same if `start_url` ever changes.
    id: '/',
    name: site.name,
    short_name: site.name,
    description: site.description,
    // `/` is the landing page for a visitor and the repositories for someone signed in (`proxy.ts`), so an installed app opens on the right one.
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // A link into Fjord, from Sovereign's launcher or anywhere else, opens the installed app where the device allows it (desktop Chrome and
    // Edge, Android Chrome), on the page it names, in a window already open if there is one (Sovereign research 0010).
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    ...LINK_CAPTURE,
    background_color: SURFACE_LIGHT,
    theme_color: SURFACE_LIGHT,
    categories: ['productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      {
        name: 'Repositories',
        short_name: 'Repositories',
        url: '/repositories',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
  };
}
