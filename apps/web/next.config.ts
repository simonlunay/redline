import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * A fully static site (`next build` writes out/). GitHub Pages serves it under /redline, so the
 * base path comes from NEXT_PUBLIC_BASE_PATH (empty for local dev and for a custom domain).
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const config: NextConfig = {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: fileURLToPath(new URL('../../', import.meta.url)) },
};

export default config;
