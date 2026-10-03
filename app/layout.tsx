import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PowerBank',
  description: 'PowerBank battery monitoring, AD5270 NTC simulator and firmware updates',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
