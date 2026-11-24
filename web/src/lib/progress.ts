import { db } from '@/lib/supabase';

/** Same five steps as the WhatsApp START checklist (src/flows/onboarding.ts in the bot), detected from real activity. */
export interface Step { id: 'first_entry' | 'costs' | 'debts' | 'receipt' | 'app' | 'video'; done: boolean; title: string; text: string; href: string | 'settings' }

const head = { count: 'exact', head: true } as const;

export async function onboardingSteps(bid: string, videosUsed: number, bot: string): Promise<Step[]> {
  const [tx, costed, debtor, repaid, receipts, push] = await Promise.all([
    db.from('transactions').select('id', head).eq('business_id', bid).eq('status', 'confirmed'),
    db.from('products').select('id', head).eq('business_id', bid).gt('cost_price_ngn', 0),
    db.from('customers').select('id', head).eq('business_id', bid).gt('outstanding_debt_ngn', 0),
    db.from('transactions').select('id', head).eq('business_id', bid).eq('tx_type', 'debt_repayment').eq('status', 'confirmed'),
    db.from('transactions').select('id', head).eq('business_id', bid).not('receipt_pdf_url', 'is', null),
    db.from('push_subscriptions').select('id', head).eq('business_id', bid),
  ]);
  const c = (r: { count: number | null }) => r.count ?? 0;
  const wa = (t: string) => `https://wa.me/${bot}?text=${encodeURIComponent(t)}`;
  return [
    { id: 'first_entry', done: c(tx) > 0, title: 'Tell me a sale or an expense', text: 'Send a voice note or type it, like “sold 2 lace 50k cash”.', href: wa('sold 2 lace 50k cash') },
    { id: 'costs', done: c(costed) > 0, title: 'Tell me what your items cost you', text: 'Type “lace costs me 15k”. This is how I work out your real profit.', href: wa('lace costs me 15k') },
    { id: 'debts', done: c(debtor) > 0 || c(repaid) > 0, title: 'Record who owes you', text: 'Type “Femi owes me 14k, Kalu 28k”.', href: wa('Femi owes me 14k') },
    { id: 'receipt', done: c(receipts) > 0, title: 'Make a customer receipt', text: 'After a sale, tap 🧾 Customer Receipt on WhatsApp.', href: wa('RECEIPT') },
    { id: 'app', done: c(push) > 0, title: 'Get your evening money alert', text: 'Add this app to your Home Screen, then open Settings and tap “Turn on my evening alert”.', href: 'settings' },
    { id: 'video', done: videosUsed > 0, title: 'Make a sales video', text: 'Send 2–3 photos of a product on WhatsApp.', href: wa('make a video for my product') },
  ];
}
