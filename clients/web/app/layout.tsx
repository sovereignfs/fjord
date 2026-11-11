import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import '@sovereignfs/ui/tokens.css';
import './globals.css';
import { site } from '../src/site';
import { SURFACE_DARK, SURFACE_LIGHT } from '../src/pwa/manifest';
import { RegisterServiceWorker } from '../src/pwa/Register';
import { themeScript } from '../src/theme/script';
import { ToastProvider } from '@sovereignfs/ui';

// Sovereign's typeface, loaded the way Sovereign's own apps load it: through `next/font`, which
// downloads it when the app is built and serves it from our own origin, so a visitor's browser
// never contacts Google and nothing third-party loads (DESIGN.md §15). The variable it sets is
// the design system's own font token, so every `--sv-font-family` in the app picks it up.
const sans = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--sv-font-family',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: site.title, template: `%s · ${site.name}` },
  description: site.description,
  openGraph: {
    title: site.title,
    description: site.description,
    siteName: site.name,
    type: 'website',
  },
  // Installed from the browser: the manifest is `app/manifest.ts`. These are for iOS, which reads the manifest for little and uses its own icon and title.
  applicationName: site.name,
  appleWebApp: { capable: true, title: site.name, statusBarStyle: 'default' },
  formatDetection: { telephone: false },
  icons: { apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  // The browser's own bar (and an installed app's title bar) takes the page's surface colour, in either scheme (`src/pwa/manifest.ts`).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: SURFACE_LIGHT },
    { media: '(prefers-color-scheme: dark)', color: SURFACE_DARK },
  ],
};

export default async function RootLayout({
  children,
  modal,
}: {
  children: ReactNode;
  /** The dialog slot (`app/@modal`): empty, unless a page opened `/account` as one. */ modal: ReactNode;
}) {
  // The proxy made a nonce for this request and put it in the policy; the theme script is inline and runs only with it (DESIGN.md §15).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // `data-theme` is set by the script before first paint, so the server's HTML and the
    // page's attributes differ by design.
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ToastProvider>
          {children}
          {modal}
        </ToastProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
