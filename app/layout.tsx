import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: 'Inter, Segoe UI, Arial, sans-serif', background: '#f8fafc' }}>
        {children}
      </body>
    </html>
  );
}
