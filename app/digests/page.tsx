import { getRecentDigests } from '../../src/store';
import type { CSSProperties } from 'react';

export const dynamic = 'force-dynamic';

export default async function DigestsPage() {
  const digests = await getRecentDigests(30);

  return (
    <main style={{ maxWidth: 1100, margin: '32px auto', padding: '0 16px' }}>
      <h1 style={{ marginTop: 0 }}>历史日报（最近30天）</h1>
      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <th style={th}>日期</th>
              <th style={th}>状态</th>
              <th style={th}>文章数</th>
              <th style={th}>发送时间</th>
              <th style={th}>Run ID</th>
            </tr>
          </thead>
          <tbody>
            {digests.map((digest) => (
              <tr key={digest.date}>
                <td style={td}>{digest.date}</td>
                <td style={td}>{digest.status ?? 'sent'}</td>
                <td style={td}>{digest.article_count}</td>
                <td style={td}>{digest.sent_at ? new Date(digest.sent_at).toLocaleString('zh-CN') : '-'}</td>
                <td style={td}>{digest.run_id ?? '-'}</td>
              </tr>
            ))}
            {digests.length === 0 && (
              <tr>
                <td colSpan={5} style={td}>暂无日报记录</td>
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
