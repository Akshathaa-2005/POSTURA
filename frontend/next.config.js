/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lets a verification build (NEXT_DIST_DIR=.next-verify) run without clobbering a running `next dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Allows importing the shared ../exercises database (also used by the backend in Phase 2).
  experimental: { externalDir: true },
};

module.exports = nextConfig;
