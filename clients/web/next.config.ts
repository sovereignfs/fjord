import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repository's root. The app imports `fjord-editor` from `packages/fjord-editor`, which is outside this project, and the
// bundler follows a link there only if its root is a directory that holds both. (It also puts a standalone server under
// `clients/web/` inside its output, which the Dockerfile follows.)
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  reactStrictMode: true,
  // Fjord Web talks to the git host from the server; nothing here should reach
  // the browser except rendered pages (clients/web/DESIGN.md §5).
  poweredByHeader: false,
  turbopack: { root },
  // Pages send `Referrer-Policy: no-referrer` (DESIGN.md §12, ROADMAP 1c.4): a link followed from a page does not tell the other
  // site where it came from, which on a shared document includes the address it was opened at.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }];
  },
  // Loaded by Node at run time, not bundled: pg is CommonJS with optional native
  // parts, and libsql ships a native addon that only the `file:` database loads.
  serverExternalPackages: ["pg", "@libsql/client", "libsql"],
  // The container image runs a self-contained server (Dockerfile). It is switched on by the image build and not
  // by default, because `next start`, which `pnpm e2e` and `pnpm boot-check` use, does not work with it.
  ...(process.env.FJORD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default config;
