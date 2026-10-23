import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import "@sovereignfs/ui/tokens.css";
import "./globals.css";
import { site } from "../src/site";
import { themeScript } from "../src/theme/script";

// Sovereign's typeface, loaded the way Sovereign's own apps load it: through `next/font`, which
// downloads it when the app is built and serves it from our own origin, so a visitor's browser
// never contacts Google and nothing third-party loads (DESIGN.md §15). The variable it sets is
// the design system's own font token, so every `--sv-font-family` in the app picks it up.
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--sv-font-family",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: site.title, template: `%s · ${site.name}` },
  description: site.description,
  openGraph: { title: site.title, description: site.description, siteName: site.name, type: "website" },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `data-theme` is set by the script before first paint, so the server's HTML and the
    // page's attributes differ by design.
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
