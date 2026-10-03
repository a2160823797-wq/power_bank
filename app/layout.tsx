import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PowerBank',
  description: 'X202 串口上位机，读取电池安全信息、异常记录并升级固件',
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
