import './globals.css';

export const metadata = { title: 'LogMem', description: 'Shared memory for your agent team.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
