import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Fjord Web talks to the git host from the server; nothing here should reach
  // the browser except rendered pages (clients/web/DESIGN.md §5).
  poweredByHeader: false,
};

export default config;
