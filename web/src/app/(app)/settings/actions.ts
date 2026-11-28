'use server';
import { revalidatePath } from 'next/cache';
import { READ_ONLY_MESSAGE, requireSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

export type SaveResult = { ok: boolean; message: string };
const THEMES = ['clean_minimalist', 'luxury_boutique', 'outdoor_lifestyle'];

export async function saveProfile(_prev: SaveResult | null, form: FormData): Promise<SaveResult> {
  const session = await requireSession(); // server actions are public endpoints: always re-authenticate
  if (session.readOnly) return { ok: false, message: READ_ONLY_MESSAGE };
  const b = session.business;
  const name = String(form.get('name') ?? '').replace(/\s+/g, ' ').trim();
  const rc = String(form.get('rc') ?? '').trim().replace(/^RC\s*/i, '');
  const theme = String(form.get('theme') ?? b.studio_theme);

  if (name.length < 2 || name.length > 80) return { ok: false, message: 'Business name must be 2–80 characters.' };
  if (rc && !/^\d{4,8}$/.test(rc)) return { ok: false, message: 'RC number should be 4–8 digits.' };
  if (!THEMES.includes(theme)) return { ok: false, message: 'Pick a valid studio theme.' };
  if (theme !== b.studio_theme && b.subscription_tier === 'free_limited') return { ok: false, message: 'Studio themes are on paid plans.' };

  const { error } = await db.from('businesses').update({ name, rc_number: rc || null, studio_theme: theme, updated_at: new Date().toISOString() }).eq('id', b.id);
  if (error) return { ok: false, message: 'Could not save. Try again.' };
  revalidatePath('/', 'layout');
  return { ok: true, message: 'Saved ✅ New receipts and videos will use this.' };
}
