import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';

export const metadata = { title: 'LogMem', description: 'Shared memory for your agent team.' };

// Clerk draws identity UI only. LogMem still owns membership and space access
// (see lib/server/auth.ts), so nothing here grants access to a space.
const appearance = {
  variables: {
    colorPrimary: '#0E6863',
    colorText: '#121A19',
    colorBackground: '#FFFFFF',
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
    borderRadius: '0.5rem',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={appearance} afterSignOutUrl="/sign-in">
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
