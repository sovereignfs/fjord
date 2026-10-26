import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Fjord Web talks to the git host from the server; nothing here should reach
  // the browser except rendered pages (clients/web/DESIGN.md §5).
  poweredByHeader: false,
  // Loaded by Node at run time, not bundled: pg is CommonJS with optional native
  // parts, and libsql ships a native addon that only the `file:` database loads.
  serverExternalPackages: ["pg", "@libsql/client", "libsql"],
  // The container image runs a self-contained server (Dockerfile). It is switched on by the image build and not
  // by default, because `next start`, which `pnpm e2e` and `pnpm boot-check` use, does not work with it.
  ...(process.env.FJORD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default config;
