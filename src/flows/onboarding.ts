import { db, type Actor, type Business } from '../db/supabase.js';
import { TRIAL_DAYS } from '../config/plans.js';
import { reply, type Reply } from '../services/whatsapp.js';

/** The five things that make Unbarmore stick. Each is detected from real activity, so the list can never lie or go stale. */
export interface Step { id: 'first_entry' | 'debts' | 'receipt' | 'app' | 'video'; done: boolean; title: string; how: string }

const head = { count: 'exact', head: true } as const;

export async function onboardingSteps(b: Pick<Business, 'id' | 'videos_used_this_month'>): Promise<Step[]> {
  const [tx, debtor, repaid, receipts, push] = await Promise.all([
    db.from('transactions').select('id', head).eq('business_id', b.id).eq('status', 'confirmed'),
    db.from('customers').select('id', head).eq('business_id', b.id).gt('outstanding_debt_ngn', 0),
    db.from('transactions').select('id', head).eq('business_id', b.id).eq('tx_type', 'debt_repayment').eq('status', 'confirmed'),
    db.from('transactions').select('id', head).eq('business_id', b.id).not('receipt_pdf_url', 'is', null),
    db.from('push_subscriptions').select('id', head).eq('business_id', b.id), // table missing (migration 004 not run) → count null → not done
  ]);
  const n = (r: { count: number | null }) => r.count ?? 0;
  return [
    { id: 'first_entry', done: n(tx) > 0, title: 'Tell me a sale or an expense', how: 'Send a voice note or type: _sold 2 lace 50k cash_' },
    { id: 'debts', done: n(debtor) > 0 || n(repaid) > 0, title: 'Record who owes you', how: 'Type: _Femi owes me 14k, Kalu 28k_' },
    { id: 'receipt', done: n(receipts) > 0, title: 'Make a customer receipt', how: 'After a sale, tap 🧾 Customer Receipt (or say RECEIPT)' },
    { id: 'app', done: n(push) > 0, title: 'Get your evening money alert', how: 'Type DASHBOARD, add it to your Home Screen, tap "Turn on my evening alert"' },
    { id: 'video', done: (b.videos_used_this_month ?? 0) > 0, title: 'Make a sales video', how: 'Send 2–3 photos of a product' },
  ];
}

export const nextStep = (steps: Step[]) => steps.find((s) => !s.done) ?? null;

export function checklistText(steps: Step[]): string {
  const done = steps.filter((s) => s.done).length;
  const next = nextStep(steps);
  return [
    '*How Unbarmore works:* you talk or send a voice note, I keep your books, and you always know your money, who owes you, and what to do next.',
    '',
    `📋 *Getting started: ${done} of ${steps.length} done*`,
    ...steps.map((s) => `${s.done ? '✅' : '⬜'} ${s.title}`),
    '',
    next ? `👉 *Next:* ${next.title}. ${next.how}` : '🎉 You\'ve done it all. You\'re running your shop on Unbarmore!',
    '',
    'Type *MENU* for everything I can do.',
  ].join('\n');
}

export async function checklistReply(actor: Actor): Promise<Reply> {
  return reply(actor.phone).text(checklistText(await onboardingSteps(actor.business)));
}

/** One line for gentle nudges. Only for accounts in their first trial period; null once everything is done. */
export async function nudgeLine(b: Business): Promise<string | null> {
  if (Date.now() - new Date(b.created_at).getTime() > (TRIAL_DAYS + 3) * 86_400_000) return null;
  const next = nextStep(await onboardingSteps(b));
  return next ? `👉 *Next step:* ${next.title}. ${next.how}` : null;
}
