import { PLANS } from '../config/plans.js';
import { consumeQuota, db, upsertProduct, type Actor, type Business } from '../db/supabase.js';
import { videoQueue, type VideoJob } from '../lib/queues.js';
import { ngn } from '../lib/money.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { quotaReply } from './ledger.js';
import type { Voice } from '../lib/videoCaption.js';

/** Creates the product lazily, records the job, enqueues the render. Returns the single acknowledgement reply. */
export async function startVideo(
  actor: Actor,
  p: { productName: string; priceNgn: number | null; deliveryInfo: string | null; rawPaths: string[]; clearance?: boolean; pidgin?: boolean; voice?: Voice },
): Promise<Reply> {
  if (!(await consumeQuota(actor.business, 'videos_used_this_month'))) return quotaReply(actor, 'videos_used_this_month');

  const product = await upsertProduct(actor.business.id, p.productName);
  if (p.priceNgn && !p.clearance) {
    await db.from('products').update({ selling_price_ngn: p.priceNgn, updated_at: new Date().toISOString() }).eq('id', product.id);
  }
  const plan = PLANS[actor.business.subscription_tier];
  const wanted = p.voice ?? (p.pidgin ? 'pidgin' : 'english');
  const insertJob = (voiceLanguage: string) => db.from('video_jobs').insert({
    business_id: actor.business.id,
    product_id: product.id,
    raw_image_urls: p.rawPaths,
    include_watermark: plan.watermark !== 'none',
    is_clearance: !!p.clearance,
    delivery_info: p.deliveryInfo,
    voice_language: voiceLanguage,
  }).select('id').single();
  let { data, error } = await insertJob(wanted === 'yoruba' ? 'yoruba' : wanted === 'pidgin' ? 'pidgin' : 'en-NG');
  let note: string | null = null;
  if (error && wanted === 'yoruba') {
    // The database rule that allows a Yoruba voice (migration 006) is not applied yet: still make the video, in English, and say so.
    console.error('[video] Yoruba not allowed by the database yet (migration 006?):', error.message);
    ({ data, error } = await insertJob('en-NG'));
    note = '⚠️ The Yoruba voice is not switched on yet, so this video is in English.';
  }
  if (error || !data) throw new Error(`video_jobs insert: ${error?.message}`);

  const job: VideoJob = { videoId: data.id as string, businessId: actor.business.id, phone: actor.phone };
  await videoQueue.add('render', job, { jobId: `video-${data.id}` });

  return reply(actor.phone).text(
    `🎬 Making your ${p.clearance ? '48-hour flash-sale ' : ''}video for *${p.productName}*${p.priceNgn ? ` at ${ngn(p.priceNgn)}` : ''}.`,
    'Customers will see your WhatsApp number on it so they can order.',
    ...(wanted === 'yoruba' && !note ? ['🗣️ Voice: Yoruba'] : []),
    ...(note ? [note] : []),
    'It arrives here in about 2 minutes. Keep selling! 💪',
  );
}

/** Clearance video for the oldest dead-stock item, reusing the photos from its last video. */
export async function startClearanceVideo(actor: Actor, b: Business, productId: string): Promise<Reply> {
  const { data: last } = await db.from('video_jobs').select('raw_image_urls').eq('product_id', productId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: product } = await db.from('products').select('name, selling_price_ngn').eq('id', productId).single();
  if (!last?.raw_image_urls?.length) {
    return reply(actor.phone).text(`Send me 2–5 photos of *${product?.name}* and I'll turn them into a 48-hour flash-sale video.`);
  }
  const price = Number(product?.selling_price_ngn ?? 0);
  void b;
  return startVideo(actor, {
    productName: product!.name as string,
    priceNgn: price > 0 ? Math.round((price * 0.9) / 100) * 100 : null, // 10% off, rounded
    deliveryInfo: null,
    rawPaths: last.raw_image_urls as string[],
    clearance: true,
  });
}

/** "YORUBA VIDEO": remake the owner's latest video (same photos, product, price) with a different voice. Counts as a new video. */
export async function remakeLastVideo(actor: Actor, voice: Voice): Promise<Reply> {
  const { data: last } = await db.from('video_jobs').select('product_id, raw_image_urls, delivery_info')
    .eq('business_id', actor.business.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!last?.raw_image_urls?.length) {
    return reply(actor.phone).text('I don\'t have photos from an earlier video yet. Send 2–5 product photos first, and add the word *Yoruba* with the name and price, like _"Cord lace, 17,500, Yoruba"_.');
  }
  const { data: product } = await db.from('products').select('name, selling_price_ngn').eq('id', last.product_id).single();
  if (!product) return reply(actor.phone).text('I couldn\'t find that product. Please send the photos again.');
  return startVideo(actor, {
    productName: product.name as string, priceNgn: Number(product.selling_price_ngn) || null,
    deliveryInfo: (last.delivery_info as string | null) === 'null' ? null : (last.delivery_info as string | null),
    rawPaths: last.raw_image_urls as string[], voice,
  });
}
