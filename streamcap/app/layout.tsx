import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'StreamCap | Live Recorder',
  description: 'Fast, lightweight live stream recorder for Telegram.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="bg-[#050505] text-white font-sans antialiased overflow-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
