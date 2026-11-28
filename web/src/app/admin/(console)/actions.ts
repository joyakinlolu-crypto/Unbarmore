'use server';
import { redirect } from 'next/navigation';
import { audit, endAdminSession, endViewAs, requireAdmin, startViewAs } from '@/lib/admin';
import { db } from '@/lib/supabase';

export async function endSessionAction() { await endAdminSession(); redirect('/admin/login'); }

/** Open a shop's real app (dashboard, charts, ledger) exactly as its owner sees it, read-only. Logged. */
export async function viewAsShop(id: string) {
  await requireAdmin();
  if (!/^[0-9a-f-]{36}$/.test(id)) redirect('/admin/shops');
  const { data } = await db.from('businesses').select('id, name').eq('id', id).maybeSingle();
  if (!data) redirect('/admin/shops');
  await audit('view_as', data as { id: string; name: string });
  await startViewAs(id);
  redirect('/dashboard');
}

/** Leave the shop view and return to its admin page. */
export async function exitViewAs(id: string) {
  await requireAdmin();
  await endViewAs();
  redirect(/^[0-9a-f-]{36}$/.test(id) ? `/admin/shops/${id}` : '/admin/shops');
}
