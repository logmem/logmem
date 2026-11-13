// Bare Clerk proxy (Next.js 16 renamed middleware to proxy): it only reads the session and finishes the Clerk handshake.
// It protects nothing. Each page and layout authorizes itself (lib/server/auth.ts).
import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next internals and static files.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
