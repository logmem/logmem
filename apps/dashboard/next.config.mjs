/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The root app already sets CLERK_PUBLISHABLE_KEY. A publishable key is public by
  // design, so mapping it here adds no new secret and needs no second env var.
  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
  },
};
