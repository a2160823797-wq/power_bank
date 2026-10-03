import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PowerBank',
  description: 'PowerBank 电池监测、数字电位器与固件升级',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
