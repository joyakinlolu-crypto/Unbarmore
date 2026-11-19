import { NextResponse, type NextRequest } from 'next/server';
import { hashToken, newRawToken } from '@/lib/auth';
import { waNumber } from '@/lib/format';
import { db } from '@/lib/supabase';
import { appUrl, sendWhatsAppText } from '@/lib/whatsapp';

export const runtime = 'nodejs';

/**
 * Always answers {ok:true}: never reveal whether a number is registered.
 * A link is only SENT when (a) the number is an active owner and (b) they messaged the bot in the last 23h
 * (free service window). Otherwise the UI tells them to send "LOGIN" on WhatsApp, which opens the window for free.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { phone?: string } | null;
  const phone = waNumber(body?.phone);
  if (!phone) return NextResponse.json({ ok: false, error: 'Enter a valid WhatsApp number' }, { status: 400 });

  try {
    const { data: user } = await db.from('business_users').select('id, business_id').eq('phone_number', phone).eq('role', 'owner').eq('is_active', true).maybeSingle();
    if (user) {
      const { data: s } = await db.from('whatsapp_sessions').select('last_inbound_at').eq('phone_number', phone).maybeSingle();
      const inWindow = s && Date.now() - new Date(s.last_inbound_at as string).getTime() < 23 * 3600_000;
      if (inWindow) {
        const raw = newRawToken();
        const { data: issued } = await db.rpc('issue_magic_token', { p_token_hash: hashToken(raw), p_business_id: user.business_id, p_user_id: user.id });
        if (issued === true) await sendWhatsAppText(phone, `🔐 Your Unbarmore login link (valid 15 min, one use):\n${appUrl()}/auth/verify?token=${raw}`);
      }
    }
  } catch (e) {
    console.error('[request-link]', e);
  }
  return NextResponse.json({ ok: true });
}
