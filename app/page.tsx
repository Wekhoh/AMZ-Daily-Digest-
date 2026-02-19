import Link from 'next/link';
import type { CSSProperties } from 'react';

const cardStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: 20,
  border: '1px solid #e2e8f0',
  boxShadow: '0 4px 12px rgba(15, 23, 42, 0.04)',
};

export default function HomePage() {
  return (
    <main style={{ maxWidth: 980, margin: '48px auto', padding: '0 16px' }}>
      <h1 style={{ marginTop: 0, color: '#0f172a' }}>AMZ Daily Digest Console</h1>
      <p style={{ color: '#475569', marginBottom: 24 }}>
        运营后台入口：查看每日任务状态、历史日报、订阅与发送结果。
      </p>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Link href="/dashboard" style={{ ...cardStyle, textDecoration: 'none', color: '#0f172a' }}>
          <h3 style={{ marginTop: 0 }}>运行看板</h3>
          <p style={{ marginBottom: 0, color: '#64748b' }}>查看最近运行状态、成功率与异常</p>
        </Link>

        <Link href="/digests" style={{ ...cardStyle, textDecoration: 'none', color: '#0f172a' }}>
          <h3 style={{ marginTop: 0 }}>历史日报</h3>
          <p style={{ marginBottom: 0, color: '#64748b' }}>查看历史发送记录与文章数量</p>
        </Link>

        <Link href="/subscribers" style={{ ...cardStyle, textDecoration: 'none', color: '#0f172a' }}>
          <h3 style={{ marginTop: 0 }}>订阅管理</h3>
          <p style={{ marginBottom: 0, color: '#64748b' }}>查看订阅者列表与投递基础配置</p>
        </Link>
      </div>
    </main>
  );
}
