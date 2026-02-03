import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local from monorepo root
config({ path: resolve(process.cwd(), '../../.env.local') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@conductor/shared'],
  experimental: {
    typedRoutes: true,
  },
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'better-sqlite3'];
    }
    return config;
  },
};

export default nextConfig;
