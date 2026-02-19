import { getRecentDigests } from '../../../src/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '30');
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 120)
    : 30;

  const digests = await getRecentDigests(limit);

  return Response.json({
    success: true,
    data: digests,
    meta: { total: digests.length, limit },
  });
}
