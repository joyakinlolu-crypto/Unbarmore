import { db } from '../db/supabase.js';

/**
 * Owner opt-out for the 7 AM and 9 PM notes. Stored as a row in outbound_log (kind 'reminders_off'), so no new table and it
 * survives restarts. Honouring "STOP" is also what WhatsApp's business policy expects.
 */
const KIND = 'reminders_off';

export async function remindersOff(businessId: string): Promise<boolean> {
  const { data } = await db.from('outbound_log').select('id').eq('business_id', businessId).eq('kind', KIND).limit(1).maybeSingle();
  return !!data;
}

export async function setReminders(businessId: string, on: boolean): Promise<void> {
  if (on) { await db.from('outbound_log').delete().eq('business_id', businessId).eq('kind', KIND); return; }
  const { error } = await db.from('outbound_log').insert({ business_id: businessId, kind: KIND, period_key: 'forever' });
  if (error && error.code !== '23505') throw new Error(`[reminders] ${error.message}`);
}
