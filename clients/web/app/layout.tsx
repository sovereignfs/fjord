import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@sovereignfs/ui/tokens.css";
import "./globals.css";
import { site } from "../src/site";
import { themeScript } from "../src/theme/script";

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
