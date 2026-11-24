import Chat, { type Msg } from '@/components/Chat';
import { requireSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { botNumber } from '@/lib/whatsapp';

export const metadata = { title: 'Advisor' };
export const dynamic = 'force-dynamic';

export default async function Advisor({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const prefill = ((await searchParams).q ?? '').slice(0, 300);
  const { business: b } = await requireSession();
  const free = b.subscription_tier === 'trial' || b.subscription_tier === 'free_limited';
  const [hist, used] = await Promise.all([
    db.from('web_chat_messages').select('id, role, content').eq('business_id', b.id).order('created_at', { ascending: false }).limit(30),
    free ? db.rpc('advisor_usage', { p_business_id: b.id }) : Promise.resolve({ data: null }),
  ]);
  const u = ((used.data as { used: number; free_limit: number }[] | null) ?? [])[0];
  const initial = ((hist.data ?? []) as Msg[]).reverse();
  return <Chat initial={initial} tier={b.subscription_tier} bot={botNumber()} freeLeft={free && u ? Math.max(0, u.free_limit - u.used) : null} freeLimit={u?.free_limit ?? 3} prefill={prefill} />;
}
