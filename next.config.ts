import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: false,
  generateBuildId: async () => 'static-build',
  assetPrefix: process.env.ELECTRON_BUILD === 'true' ? '' : undefined
};

export default nextConfig;
