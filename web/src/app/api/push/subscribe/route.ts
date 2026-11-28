import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { parseSubscription } from '@/lib/pushSub';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';

const MAX_DEVICES = 8; // newest devices kept per business

/** Same-site browsers only: if the browser says where the request came from, it must be us. */
function sameOrigin(req: NextRequest): boolean {
  const o = req.headers.get('origin');
  return !o || new URL(o).host === req.headers.get('host');
}

const notReady = (code: string | undefined) => code === '42P01' || code === 'PGRST205'; // migration 004 not run yet

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (session.readOnly) return NextResponse.json({ error: 'read_only' }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sub = parseSubscription(await req.json().catch(() => null));
  if (!sub) return NextResponse.json({ error: 'invalid subscription' }, { status: 400 });

  const bid = session.business_id;
  const { error } = await db.from('push_subscriptions').upsert(
    { business_id: bid, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_agent: (req.headers.get('user-agent') ?? '').slice(0, 200), fail_count: 0 },
    { onConflict: 'endpoint' },
  );
  if (error) return NextResponse.json({ error: notReady(error.code) ? 'not_ready' : 'save failed' }, { status: notReady(error.code) ? 503 : 500 });

  // Keep the newest few devices per business.
  const { data: all } = await db.from('push_subscriptions').select('id').eq('business_id', bid).order('created_at', { ascending: false });
  const extra = (all ?? []).slice(MAX_DEVICES).map((r) => r.id as string);
  if (extra.length) await db.from('push_subscriptions').delete().in('id', extra);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (session.readOnly) return NextResponse.json({ error: 'read_only' }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== 'string') return NextResponse.json({ error: 'invalid' }, { status: 400 });
  await db.from('push_subscriptions').delete().eq('business_id', session.business_id).eq('endpoint', body.endpoint);
  return NextResponse.json({ ok: true });
}
