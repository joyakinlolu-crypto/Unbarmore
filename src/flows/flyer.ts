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
  'Add *SALE*, *NEW* or *RESTOCK* for the headline, and *NAVY* or *WINE* for a colour.',
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

export async function flyerReply(actor: Actor, photo: Buffer, caption: string, palette = 0, tag?: string): Promise<Reply> {
  const parsed = flyerCaption(caption);
  if (!parsed) {
    return reply(actor.phone).text('I need the product name and price in the caption, like: _flyer Ankara gown 15k_');
  }
  const png = await renderFlyer({
    photo, businessName: actor.business.name, product: parsed.name, priceNgn: parsed.price,
    contact: displayPhone(actor.business.sales_phone ?? actor.business.owner_phone), logo: await loadLogo(actor.business),
    footer: PLANS[actor.business.subscription_tier].watermark !== 'none', palette, tag,
  });
  const path = await uploadFile('cleaned-images', `${actor.business.id}/flyers/${Date.now()}.png`, png, 'image/png');
  return reply(actor.phone)
    .image(await signedUrl('cleaned-images', path))
    .text(`🖼️ *${parsed.name}* is ready. Post it on your WhatsApp Status now.`, 'Other looks: add *NAVY* or *WINE* for a colour, and *SALE*, *NEW* or *RESTOCK* for the headline, e.g. _flyer gele 5k sale navy_.');
}

/** NAVY / WINE at the end of the caption picks another colour. */
export function pickPalette(caption: string): { caption: string; palette: number } {
  const m = caption.match(/\b(navy|wine)\b\s*$/i);
  if (!m) return { caption, palette: 0 };
  return { caption: caption.slice(0, m.index).trim(), palette: m[1]!.toLowerCase() === 'navy' ? 1 : 2 };
}

/** SALE / NEW / RESTOCK at the end of the caption changes the headline tag. */
export const TAGS: Record<string, string> = { sale: 'SALE', new: 'NEW ARRIVAL', restock: 'BACK IN STOCK' };
export function pickTag(caption: string): { caption: string; tag: string | undefined } {
  const m = caption.match(/\b(sale|new|restock)\b\s*$/i);
  if (!m) return { caption, tag: undefined };
  return { caption: caption.slice(0, m.index).trim(), tag: TAGS[m[1]!.toLowerCase()] };
}

/** "flyer gele 5k sale navy", "flyer gele 5k navy sale": colour and tag may come in either order. */
export function parseFlyerOptions(caption: string): { caption: string; palette: number; tag: string | undefined } {
  let c = caption, palette = 0, tag: string | undefined;
  for (let i = 0; i < 2; i++) {
    const p = pickPalette(c); if (p.caption !== c) { palette = p.palette; c = p.caption; continue; }
    const t = pickTag(c); if (t.caption !== c) { tag = t.tag; c = t.caption; continue; }
    break;
  }
  return { caption: c, palette, tag };
}

// ───────────── Logo maker ─────────────

export function logoColourPicker(phone: string, batchId: string | null): Reply {
  const b = batchId ?? '-';
  const r = reply(phone).text('✨ *Let\'s make your logo.* Pick a colour:');
  PALETTES.forEach((p, i) => r.button(`LOGOC:${i}:${b}`, p.name));
  return r;
}

/** Draws an initials logo, saves it as the owner's logo (receipts + invoices), and sends it back so it can become the WhatsApp profile picture. */
export async function makeLogoReply(actor: Actor, paletteIdx: number): Promise<Reply> {
  const png = await renderLogo(initials(actor.business.name), paletteIdx);
  await saveLogo(actor, png, { generated: true });
  const path = actor.business.logo_url!;
  return reply(actor.phone)
    .image(await signedUrl('cleaned-images', path))
    .text('✅ *Your logo is ready* and it now appears on your receipts and invoices.', 'Tip: save this picture and set it as your WhatsApp business profile photo.', '*Have your own logo?* Tap below, or send the photo with the word *logo* as its caption, any time.')
    .button('LOGO:ask:-', '📷 Use my own logo')
    .button('LOGO:keep:-', '👍 Keep this one');
}

