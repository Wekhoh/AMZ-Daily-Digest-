import { getSubscribers } from '../../src/store';
import type { CSSProperties } from 'react';

export const dynamic = 'force-dynamic';

export default async function SubscribersPage() {
  const subscribers = await getSubscribers(200);

  return (
    <main style={{ maxWidth: 900, margin: '32px auto', padding: '0 16px' }}>
      <h1 style={{ marginTop: 0 }}>订阅者管理（只读）</h1>
      <p style={{ color: '#64748b' }}>
        可通过 <code>POST /api/subscribers</code> 添加订阅邮箱，当前页面展示订阅列表与状态。
      </p>

      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <th style={th}>邮箱</th>
              <th style={th}>状态</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((subscriber) => (
              <tr key={subscriber.id}>
                <td style={td}>{subscriber.email}</td>
                <td style={td}>{subscriber.active ? 'active' : 'inactive'}</td>
              </tr>
            ))}
            {subscribers.length === 0 && (
              <tr>
                <td colSpan={2} style={td}>暂无订阅者</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 13,
  color: '#334155',
  padding: '12px 16px',
  borderBottom: '1px solid #e2e8f0',
};

const td: CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid #f1f5f9',
  fontSize: 13,
  color: '#0f172a',
};
