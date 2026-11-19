import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';

/** Ownership-checked redirect to a 60-second signed URL. The storage bucket stays private. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data } = await db.from('transactions').select('receipt_pdf_url').eq('id', id).eq('business_id', session.business_id).maybeSingle();
  const path = data?.receipt_pdf_url as string | null | undefined;
  if (!path) return NextResponse.json({ error: 'No receipt for this entry' }, { status: 404 });
  const { data: signed } = await db.storage.from('pdf-receipts').createSignedUrl(path, 60, { download: path.split('/').pop() });
  if (!signed) return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  return NextResponse.redirect(signed.signedUrl, 302);
}
