import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Keep the build light: one static-generation worker.
  experimental: { cpus: 1 },
}

export default nextConfig
