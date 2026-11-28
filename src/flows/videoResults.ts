import { db, type Actor } from '../db/supabase.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { followupDue, followupQuestion, isVideoResult, resultAnswer, FOLLOWUP_FROM_DAYS, FOLLOWUP_TO_DAYS, type VideoResult } from '../lib/videoResults.js';

const DAY = 86_400_000;

/** The oldest finished video of this shop that is due its one question, or null. Claims it (followup_sent_at) so it is only ever asked once. */
export async function claimDueFollowup(businessId: string, phone: string, now = Date.now()): Promise<Reply | null> {
  try {
    const { data } = await db.from('video_jobs').select('id, created_at, product_id, products(name)')
      .eq('business_id', businessId).eq('status', 'completed').is('followup_sent_at', null).is('result', null)
      .gte('created_at', new Date(now - FOLLOWUP_TO_DAYS * DAY).toISOString()).lte('created_at', new Date(now - FOLLOWUP_FROM_DAYS * DAY).toISOString())
      .order('created_at', { ascending: true }).limit(1);
    const v = data?.[0] as { id: string; created_at: string; products?: { name?: string } | { name?: string }[] | null } | undefined;
    if (!v || !followupDue(v.created_at, now)) return null;
    const claimed = await db.from('video_jobs').update({ followup_sent_at: new Date(now).toISOString() }).eq('id', v.id).is('followup_sent_at', null).select('id');
    if (!claimed.data?.length) return null;                                   // someone else got there first
    const prod = Array.isArray(v.products) ? v.products[0]?.name : v.products?.name;
    return reply(phone).text(...followupQuestion(prod ?? null, v.created_at, now))
      .button(`VRES:${v.id}:yes`, '✅ Yes, a customer').button(`VRES:${v.id}:no`, '😕 Posted, none yet').button(`VRES:${v.id}:unposted`, '📵 Not posted yet');
  } catch { return null; }                                                    // migration 015 not run yet: skip quietly
}

/** The owner tapped an answer. Only their own video can be answered; answering twice keeps the first answer. */
export async function recordVideoResult(actor: Actor, videoId: string | undefined, answer: string | undefined): Promise<Reply> {
  if (!videoId || !isVideoResult(answer)) return reply(actor.phone).text('Thanks! I could not match that answer.');
  const r: VideoResult = answer;
  try {
    await db.from('video_jobs').update({ result: r, result_at: new Date().toISOString() }).eq('id', videoId).eq('business_id', actor.business.id).is('result', null);
  } catch { /* migration missing: still thank them */ }
  return reply(actor.phone).text(...resultAnswer(r));
}

/** Admin scorecard line: how many videos were reported as bringing a customer. null when nobody has answered yet. */
export async function videoResultsLine(): Promise<string | null> {
  try {
    const { data } = await db.from('video_jobs').select('result').not('result', 'is', null).limit(5000);
    const rows = (data ?? []) as { result: string }[];
    if (!rows.length) return null;
    const n = (k: string) => rows.filter((x) => x.result === k).length;
    return `🎬 Videos reported: ${n('yes')} brought a customer · ${n('no')} posted, none yet · ${n('unposted')} not posted (${rows.length} answers)`;
  } catch { return null; }
}
