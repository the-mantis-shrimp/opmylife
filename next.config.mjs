/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The worker shares this codebase but is started separately (`npm run worker`).
    // Keep server-only native/heavy packages out of the client bundle.
    serverComponentsExternalPackages: ["pg", "bullmq", "ioredis", "@aws-sdk/client-s3"],
  },
};

export default nextConfig;
