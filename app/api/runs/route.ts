import { getRecentRuns } from '../../../src/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '20');
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : 20;

  const runs = await getRecentRuns(limit);

  return Response.json({
    success: true,
    data: runs,
    meta: { total: runs.length, limit },
  });
}
