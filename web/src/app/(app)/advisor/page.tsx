import Chat, { type Msg } from '@/components/Chat';
import { requireSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { botNumber } from '@/lib/whatsapp';

export const metadata = { title: 'Advisor' };
export const dynamic = 'force-dynamic';

export default async function Advisor() {
  const { business: b } = await requireSession();
  const free = b.subscription_tier === 'trial' || b.subscription_tier === 'free_limited';
  const [hist, used] = await Promise.all([
    db.from('web_chat_messages').select('id, role, content').eq('business_id', b.id).order('created_at', { ascending: false }).limit(30),
    free ? db.rpc('advisor_messages_this_month', { p_business_id: b.id }) : Promise.resolve({ data: 0 }),
  ]);
  const initial = ((hist.data ?? []) as Msg[]).reverse();
  return <Chat initial={initial} tier={b.subscription_tier} bot={botNumber()} freeLeft={free ? Math.max(0, 10 - Number(used.data ?? 0)) : null} />;
}
