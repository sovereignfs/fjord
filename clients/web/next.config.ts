import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Fjord Web talks to the git host from the server; nothing here should reach
  // the browser except rendered pages (clients/web/DESIGN.md §5).
  poweredByHeader: false,
  // Loaded by Node at run time, not bundled: pg is CommonJS with optional native
  // parts, and libsql ships a native addon that only the `file:` database loads.
  serverExternalPackages: ["pg", "@libsql/client", "libsql"],
};

export default config;
