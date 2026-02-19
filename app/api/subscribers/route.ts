import { addSubscriber, getSubscribers } from '../../../src/store';

export const dynamic = 'force-dynamic';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 500)
    : 100;
  const subscribers = await getSubscribers(limit);
  return Response.json({
    success: true,
    data: subscribers,
    meta: { total: subscribers.length, limit },
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { email?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (!email || !EMAIL_REGEX.test(email)) {
    return Response.json(
      { success: false, error: 'Invalid email format' },
      { status: 400 },
    );
  }

  const subscriber = await addSubscriber(email);
  return Response.json({ success: true, data: subscriber });
}
