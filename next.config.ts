import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["node:sqlite"],
  poweredByHeader: false,
  experimental: { cpus: 2 },
};
export default config;
