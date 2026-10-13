import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Fashion Rockstar Ops', description: 'Multi-channel inventory, profit and listing management' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
