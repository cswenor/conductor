import type { NextConfig } from 'next';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local from monorepo root
config({ path: resolve(process.cwd(), '../../.env.local') });

const nextConfig: NextConfig = {
  transpilePackages: ['@conductor/shared'],
  // typedRoutes disabled — broken in Next.js 16 (vercel/next.js#86156)
  // experimental: { typedRoutes: true },
  serverExternalPackages: ['better-sqlite3'],
  // Turbopack lacks extensionAlias support (vercel/next.js#82945) needed for
  // the shared package's .js→.ts imports, so we keep webpack for now.
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },
};

export default nextConfig;
