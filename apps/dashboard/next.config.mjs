import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard imports server modules from the repo's root src folder, so the
// bundler and the file tracer both need the repo root, not this folder.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // The root app already sets CLERK_PUBLISHABLE_KEY. A publishable key is public by
  // design, so mapping it here adds no new secret and needs no second env var.
  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
  },
};
