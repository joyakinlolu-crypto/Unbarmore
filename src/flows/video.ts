import { PLANS } from '../config/plans.js';
import { consumeQuota, db, upsertProduct, type Actor, type Business } from '../db/supabase.js';
import { videoQueue, type VideoJob } from '../lib/queues.js';
import { ngn } from '../lib/money.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { quotaReply } from './ledger.js';

/** Creates the product lazily, records the job, enqueues the render. Returns the single acknowledgement reply. */
export async function startVideo(
  actor: Actor,
  p: { productName: string; priceNgn: number | null; deliveryInfo: string | null; rawPaths: string[]; clearance?: boolean; pidgin?: boolean },
): Promise<Reply> {
  if (!(await consumeQuota(actor.business, 'videos_used_this_month'))) return quotaReply(actor, 'videos_used_this_month');

  const product = await upsertProduct(actor.business.id, p.productName);
  if (p.priceNgn && !p.clearance) {
    await db.from('products').update({ selling_price_ngn: p.priceNgn, updated_at: new Date().toISOString() }).eq('id', product.id);
  }
  const plan = PLANS[actor.business.subscription_tier];
  const { data, error } = await db.from('video_jobs').insert({
    business_id: actor.business.id,
    product_id: product.id,
    raw_image_urls: p.rawPaths,
    include_watermark: plan.watermark !== 'none',
    is_clearance: !!p.clearance,
    delivery_info: p.deliveryInfo,
    voice_language: p.pidgin ? 'pidgin' : 'en-NG',
  }).select('id').single();
  if (error || !data) throw new Error(`video_jobs insert: ${error?.message}`);

  const job: VideoJob = { videoId: data.id as string, businessId: actor.business.id, phone: actor.phone };
  await videoQueue.add('render', job, { jobId: `video-${data.id}` });

  return reply(actor.phone).text(
    `🎬 Making your ${p.clearance ? '48-hour flash-sale ' : ''}video for *${p.productName}*${p.priceNgn ? ` at ${ngn(p.priceNgn)}` : ''}.`,
    `Order code: *${product.sku_code}* — customers send this to order.`,
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
