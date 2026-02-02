/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@conductor/shared'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
