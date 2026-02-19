export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
    },
  });
}
