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
};

export default nextConfig;
