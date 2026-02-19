import { getRecentRuns } from '../../src/store';
import type { CSSProperties, ReactNode } from 'react';

const badgeColor: Record<string, string> = {
  running: '#0369a1',
  sent: '#166534',
  failed: '#b91c1c',
  skipped: '#92400e',
};

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const runs = await getRecentRuns(20);
  const total = runs.length;
  const sent = runs.filter((r) => r.status === 'sent').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : '0.0';

  return (
    <main style={{ maxWidth: 1100, margin: '32px auto', padding: '0 16px' }}>
      <h1 style={{ marginTop: 0 }}>运行看板</h1>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', marginBottom: 20 }}>
        <StatCard label="近20次运行" value={String(total)} />
        <StatCard label="发送成功" value={String(sent)} />
        <StatCard label="失败次数" value={String(failed)} />
        <StatCard label="成功率" value={`${successRate}%`} />
      </div>

      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <Th>日期</Th>
              <Th>状态</Th>
              <Th>文章数</Th>
              <Th>开始时间</Th>
              <Th>结束时间</Th>
              <Th>错误</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.run_id}>
                <Td>{run.digest_date}</Td>
                <Td>
                  <span
                    style={{
                      background: `${badgeColor[run.status] ?? '#334155'}20`,
                      color: badgeColor[run.status] ?? '#334155',
                      borderRadius: 999,
                      padding: '3px 10px',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {run.status}
                  </span>
                </Td>
                <Td>{String(run.article_count)}</Td>
                <Td>{new Date(run.started_at).toLocaleString('zh-CN')}</Td>
                <Td>{run.finished_at ? new Date(run.finished_at).toLocaleString('zh-CN') : '-'}</Td>
                <Td style={{ maxWidth: 320 }}>{run.error_message ?? '-'}</Td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <Td colSpan={6}>暂无运行记录（请先执行一次 digest）</Td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <article style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
      <div style={{ color: '#64748b', fontSize: 13 }}>{label}</div>
      <div style={{ color: '#0f172a', fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </article>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th style={{ textAlign: 'left', fontSize: 13, color: '#334155', padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
      {children}
    </th>
  );
}

function Td({ children, colSpan, style }: { children: ReactNode; colSpan?: number; style?: CSSProperties }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid #f1f5f9',
        fontSize: 13,
        color: '#0f172a',
        ...style,
      }}
    >
      {children}
    </td>
  );
}
