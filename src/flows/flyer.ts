import { PLANS } from '../config/plans.js';
import { signedUrl, uploadFile, type Actor } from '../db/supabase.js';
import { displayPhone } from '../lib/phone.js';
import { parseVideoCaption } from '../lib/videoCaption.js';
import { PALETTES, renderFlyer, renderLogo } from '../services/flyer.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { initials, loadLogo, saveLogo } from './branding.js';

/** Free, instant, no AI: an "AVAILABLE NOW" picture for WhatsApp Status, from the owner's own product photo. */
export const FLYER_PER_DAY = 10;
export const FLYER_HELP = [
  '🖼️ *Make a free "Available now" picture for your WhatsApp Status.*',
  'Send ONE product photo with a caption like:',
  '_flyer Ankara gown 15k_',
  'I add your business name, the price and your WhatsApp number. Takes a few seconds, costs nothing.',
];

/** "flyer Ankara gown 15k", "FLYER: gele 5,000" → the part after the word. null = this caption is not a flyer request. */
export function flyerCaption(caption: string): { name: string; price: number } | null {
  const m = caption.trim().match(/^flyer\b[\s:,-]*(.*)$/i);
  if (!m) return null;
  const d = parseVideoCaption(m[1]!.trim());
  return d ? { name: d.name, price: d.price } : null;
}
export const isFlyerCaption = (caption: string) => /^flyer\b/i.test(caption.trim());

export async function flyerReply(actor: Actor, photo: Buffer, caption: string, palette = 0): Promise<Reply> {
  const parsed = flyerCaption(caption);
  if (!parsed) {
    return reply(actor.phone).text('I need the product name and price in the caption, like: _flyer Ankara gown 15k_');
  }
  const png = await renderFlyer({
    photo, businessName: actor.business.name, product: parsed.name, priceNgn: parsed.price,
    contact: displayPhone(actor.business.sales_phone ?? actor.business.owner_phone), logo: await loadLogo(actor.business),
    footer: PLANS[actor.business.subscription_tier].watermark !== 'none', palette,
  });
  const path = await uploadFile('cleaned-images', `${actor.business.id}/flyers/${Date.now()}.png`, png, 'image/png');
  return reply(actor.phone)
    .image(await signedUrl('cleaned-images', path))
    .text(`🖼️ *${parsed.name}* is ready. Post it on your WhatsApp Status now.`, 'Want another colour? Send the photo again with the same caption and add NAVY or WINE.');
}

/** NAVY / WINE at the end of the caption picks another colour. */
export function pickPalette(caption: string): { caption: string; palette: number } {
  const m = caption.match(/\b(navy|wine)\b\s*$/i);
  if (!m) return { caption, palette: 0 };
  return { caption: caption.slice(0, m.index).trim(), palette: m[1]!.toLowerCase() === 'navy' ? 1 : 2 };
}

// ───────────── Logo maker ─────────────

export function logoColourPicker(phone: string, batchId: string | null): Reply {
  const b = batchId ?? '-';
  const r = reply(phone).text('✨ *Let\'s make your logo.* Pick a colour:');
  PALETTES.forEach((p, i) => r.button(`LOGOC:${i}:${b}`, p.name));
  return r;
}

/** Draws an initials logo, saves it as the owner's logo (receipts + quotes), and sends it back so it can become the WhatsApp profile picture. */
export async function makeLogoReply(actor: Actor, paletteIdx: number): Promise<Reply> {
  const png = await renderLogo(initials(actor.business.name), paletteIdx);
  await saveLogo(actor, png);
  const path = actor.business.logo_url!;
  return reply(actor.phone)
    .image(await signedUrl('cleaned-images', path))
    .text('✅ *Your logo is ready* and it now appears on your receipts and quotes.', 'Tip: save this picture and set it as your WhatsApp business profile photo.', 'Have a real logo? Send LOGO and then your photo, any time.');
}

