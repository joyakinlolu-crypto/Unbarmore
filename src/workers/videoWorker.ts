import { Worker, type Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';
import { MINI_VIDEO, PLANS } from '../config/plans.js';
import { db, downloadFile, getBusiness, getProduct, refundQuota, refundVideoCredit, signedUrl, uploadFile } from '../db/supabase.js';
import { uncountVideoToday } from '../lib/videoDaily.js';
import { reusableCleaned } from '../lib/cleanedReuse.js';
import { QUEUE, redisConnection, type VideoJob } from '../lib/queues.js';
import { ngn } from '../lib/money.js';
import { displayPhone } from '../lib/phone.js';
import { photosForVideo } from '../lib/videoPhotos.js';
import { bindUsageToBusiness } from '../lib/usage.js';
import { writeVideoScript, type VideoScript } from '../services/geminiBrain.js';
import { enhanceProductPhoto, type StudioTheme } from '../services/imageStudio.js';
import { synthesizeVoiceover } from '../services/ttsService.js';
import { reply } from '../services/whatsapp.js';
import { alertAdmin, noteGeminiError } from '../lib/alerts.js';

const W = 1080;
const H = 1920;
const FPS = 30;
const MAX_BYTES = 3.5 * 1024 * 1024;

// ═════════════════════════ PURE RENDERER (testable without network) ═════════════════════════

export interface RenderInput {
  images: string[];            // local file paths, already cleaned
  voiceover: string | null;    // local mp3 path
  bgm: string | null;          // local instrumental path
  captions: string[];          // 3 lines
  priceText: string | null;    // "₦15,000"
  /** @deprecated customers no longer see a code; kept so older callers compile. */
  orderCode?: string;
  /** The shop's WhatsApp number as customers dial it, e.g. "0810 713 6951". Shown on screen so people can order. */
  contactPhone?: string | null;
  watermark: 'full' | 'subtle' | 'none';
  clearance: boolean;
  /** ~10-second preview (trial / free plan) instead of the 15–18 second HD ad. */
  mini?: boolean;
  /** Retry mode for small containers: 1 thread, no oversampling. Slower, but fits in a few hundred MB. */
  lowMem?: boolean;
  fontPath: string;
  outPath: string;
  workDir: string;
}

const probeDuration = (file: string) =>
  new Promise<number>((resolve, reject) =>
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(Number(data.format.duration ?? 0)))));

/** drawtext reads text from files — sidesteps FFmpeg's escaping rules for ₦, quotes, colons and emoji-less Pidgin. */
async function textFile(dir: string, name: string, text: string): Promise<string> {
  const p = path.join(dir, `${name}.txt`);
  await fs.writeFile(p, text, 'utf8');
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/** Normal render; if the container kills ffmpeg for memory (SIGKILL), retry once in low-memory mode instead of failing the customer's video. */
export async function renderVideo(input: RenderInput, maxrateK = 1300): Promise<{ bytes: number; duration: number }> {
  try {
    return await renderOnce(input, maxrateK);
  } catch (err) {
    if (input.lowMem || !/SIGKILL|killed|Cannot allocate|ENOMEM/i.test(String((err as Error)?.message ?? err))) throw err;
    console.error('[video] ffmpeg ran out of memory; retrying in low-memory mode');
    return renderOnce({ ...input, lowMem: true }, maxrateK);
  }
}

async function renderOnce(input: RenderInput, maxrateK = 1300): Promise<{ bytes: number; duration: number }> {
  const voiceDur = input.voiceover ? await probeDuration(input.voiceover) : 0;
  const endCard = input.watermark === 'full' ? (input.mini ? 1.2 : 1.6) : 0;
  // Speech is never cut off: if the voice would overrun the video, it is sped up (at most 1.25x) to fit.
  const maxTotal = input.mini ? MINI_VIDEO.maxSeconds : 20;
  const minTotal = input.mini ? MINI_VIDEO.minSeconds : 15;
  const overhead = (input.mini ? 0.7 : 1.2) + endCard;
  const tempo = voiceDur > 0 ? Math.min(1.25, Math.max(1, voiceDur / (maxTotal - overhead))) : 1;
  const tempoF = tempo > 1.001 ? `atempo=${tempo.toFixed(3)},` : '';
  const total = Math.min(maxTotal, Math.max(minTotal, voiceDur / tempo + overhead));
  const n = input.images.length;
  const seg = (total - endCard) / n;
  const segFrames = Math.ceil(seg * FPS);
  const font = input.fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const filters: string[] = [];
  // Memory matters: Railway kills ffmpeg (SIGKILL) when the container runs out of RAM. 1.5x (not 2x) is still smooth for a 10% zoom; lowMem retry uses 1.15x.
  const OW = input.lowMem ? Math.round((W * 1.15) / 2) * 2 : W * 1.5, OH = input.lowMem ? Math.round((H * 1.15) / 2) * 2 : H * 1.5;
  // 1) Ken Burns per image: cover-crop to 9:16 at 1.5x for smooth sub-pixel zoom, alternate zoom-in / zoom-out.
  input.images.forEach((_, i) => {
    const zoom = i % 2 === 0 ? `min(1+0.10*on/${segFrames},1.10)` : `max(1.10-0.10*on/${segFrames},1.0)`;
    filters.push(
      `[${i}:v]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},setsar=1,` +
      `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${segFrames}:s=${W}x${H}:fps=${FPS},` +
      `trim=duration=${seg.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`,
    );
  });
  // 2) Cross-fade between photos.
  const xf = 0.35;
  let last = 'v0';
  let offset = seg - xf;
  for (let i = 1; i < n; i++) {
    filters.push(`[${last}][v${i}]xfade=transition=fade:duration=${xf}:offset=${offset.toFixed(3)}[x${i}]`);
    last = `x${i}`;
    offset += seg - xf;
  }
  const slidesDur = seg * n - xf * (n - 1);
  // 3) End card (watermark tier) — dark brand frame appended.
  if (endCard > 0) {
    filters.push(`color=c=0x0B1F17:s=${W}x${H}:r=${FPS}:d=${endCard},format=yuv420p[end]`);
    filters.push(`[${last}][end]concat=n=2:v=1:a=0[vc]`);
    last = 'vc';
  }

  // 4) Overlays.
  const draw: string[] = [];
  const capT = (slidesDur - 0.2) / Math.max(1, input.captions.length);
  for (const [i, cap] of input.captions.entries()) {
    const tf = await textFile(input.workDir, `cap${i}`, cap.toUpperCase());
    draw.push(
      `drawtext=fontfile='${font}':textfile='${tf}':fontsize=74:fontcolor=white:borderw=6:bordercolor=black@0.85:` +
      `box=1:boxcolor=black@0.35:boxborderw=28:x=(w-text_w)/2:y=h*0.13:enable='between(t,${(i * capT).toFixed(2)},${((i + 1) * capT).toFixed(2)})'`,
    );
  }
  if (input.priceText) {
    const tf = await textFile(input.workDir, 'price', input.clearance ? `NOW ${input.priceText}` : input.priceText);
    draw.push(
      `drawtext=fontfile='${font}':textfile='${tf}':fontsize=86:fontcolor=0x0B1F17:box=1:boxcolor=0xFFD23F:boxborderw=26:` +
      `x=w-text_w-70:y=h*0.62:enable='gte(t,0.6)*lt(t,${slidesDur.toFixed(2)})'`,
    );
  }
  if (input.clearance) {
    const tf = await textFile(input.workDir, 'flash', '48-HOUR FLASH SALE');
    draw.push(`drawtext=fontfile='${font}':textfile='${tf}':fontsize=58:fontcolor=white:box=1:boxcolor=0xD92D20:boxborderw=20:x=(w-text_w)/2:y=h*0.06:enable='lt(t,${slidesDur.toFixed(2)})'`);
  }
  const ctaFile = await textFile(input.workDir, 'cta', input.contactPhone ? `WhatsApp ${input.contactPhone} to order` : 'Message us on WhatsApp to order');
  draw.push(
    `drawtext=fontfile='${font}':textfile='${ctaFile}':fontsize=40:fontcolor=white:box=1:boxcolor=0x0E7A4F@0.92:boxborderw=24:` +
    `x=(w-text_w)/2:y=h*0.84:enable='lt(t,${slidesDur.toFixed(2)})'`,
  );
  if (input.watermark === 'full') {
    const a = await textFile(input.workDir, 'wm1', input.contactPhone ?? 'Order on WhatsApp');
    const b = await textFile(input.workDir, 'wm2', 'Made with Unbarmore');
    const c = await textFile(input.workDir, 'wm3', 'unbarmore.com');
    const at = `enable='gte(t,${slidesDur.toFixed(2)})'`;
    draw.push(`drawtext=fontfile='${font}':textfile='${a}':fontsize=${input.contactPhone ? 84 : 70}:fontcolor=0xFFD23F:x=(w-text_w)/2:y=h*0.40:${at}`);
    draw.push(`drawtext=fontfile='${font}':textfile='${b}':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=h*0.52:${at}`);
    draw.push(`drawtext=fontfile='${font}':textfile='${c}':fontsize=44:fontcolor=white@0.7:x=(w-text_w)/2:y=h*0.58:${at}`);
  } else if (input.watermark === 'subtle') {
    const b = await textFile(input.workDir, 'wm', 'unbarmore.com');
    draw.push(`drawtext=fontfile='${font}':textfile='${b}':fontsize=30:fontcolor=white@0.55:x=w-text_w-36:y=h-text_h-40:enable='gte(t,${(slidesDur - 2.5).toFixed(2)})'`);
  }
  filters.push(`[${last}]${draw.join(',')}[vout]`);

  // 5) Audio: voiceover delayed 0.4s; instrumental ducked under voice (sidechain) and faded out.
  const audioIdx = n;
  let aMap: string | null = null;
  if (input.voiceover && input.bgm) {
    filters.push(`[${audioIdx}:a]${tempoF}adelay=400|400,apad,atrim=duration=${total.toFixed(2)},aformat=channel_layouts=stereo,asplit=2[vo][sc]`);
    filters.push(`[${audioIdx + 1}:a]aloop=loop=-1:size=2e9,atrim=duration=${total.toFixed(2)},volume=0.55,aformat=channel_layouts=stereo,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[bg]`);
    filters.push(`[bg][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[duck]`);
    filters.push(`[vo][duck]amix=inputs=2:duration=first:normalize=0[aout]`);
    aMap = '[aout]';
  } else if (input.voiceover) {
    filters.push(`[${audioIdx}:a]${tempoF}adelay=400|400,apad,atrim=duration=${total.toFixed(2)}[aout]`);
    aMap = '[aout]';
  } else if (input.bgm) {
    filters.push(`[${audioIdx}:a]atrim=duration=${total.toFixed(2)},afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[aout]`);
    aMap = '[aout]';
  }

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg();
    for (const img of input.images) cmd.input(img).inputOptions(['-threads 1'])  // ONE still frame in: zoompan makes exactly segFrames frames from it (looping the photo as video made it do ~100x the work);
    if (input.voiceover) cmd.input(input.voiceover);
    if (input.bgm) cmd.input(input.bgm);
    cmd
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-map [vout]',
        ...(aMap ? [`-map ${aMap}`] : []),
        '-c:v libx264', '-preset veryfast', '-profile:v high', '-level 4.1', '-pix_fmt yuv420p',
        '-crf 27', `-maxrate ${maxrateK}k`, `-bufsize ${maxrateK * 2}k`, `-r ${FPS}`, '-g 60',
        ...(aMap ? ['-c:a aac', '-b:a 96k', '-ar 44100'] : ['-an']),
        `-t ${total.toFixed(2)}`,
        '-movflags +faststart',
        // Cap parallelism: '-threads 0' spawned ~60 x264 threads on the host's cores and blew past the container's RAM.
        `-threads ${input.lowMem ? 1 : 2}`, '-filter_threads 1', '-filter_complex_threads 1',
        '-x264-params', `threads=${input.lowMem ? 1 : 2}:lookahead_threads=1:rc-lookahead=10`,
      ])
      .on('error', (err, _o, stderr) => reject(new Error(`${err.message}\n${String(stderr).slice(-1500)}`)))
      .on('end', () => resolve())
      .save(input.outPath);
  });

  const { size } = await fs.stat(input.outPath);
  // Mobile-data budget: if over 3.5MB, re-encode once at a computed lower bitrate.
  if (size > MAX_BYTES && maxrateK > 500) {
    const target = Math.floor(((MAX_BYTES * 8) / total / 1000 - 110) * 0.92);
    return renderOnce(input, Math.max(500, target));
  }
  return { bytes: size, duration: total };
}

async function pickBgm(): Promise<string | null> {
  try {
    const files = (await fs.readdir(env.BGM_DIR)).filter((f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f));
    if (!files.length) return null;
    return path.join(env.BGM_DIR, files[Math.floor(Math.random() * files.length)]!);
  } catch {
    return null;
  }
}

// ═════════════════════════ JOB ═════════════════════════

async function processVideo(job: Job<VideoJob>): Promise<void> {
  const { videoId, businessId, phone } = job.data;
  const { data: row, error } = await db.from('video_jobs').select('*').eq('id', videoId).single();
  if (error || !row) throw new Error(`video_jobs ${videoId} not found`);
  if (row.status === 'completed') return;

  await db.from('video_jobs').update({ status: 'processing' }).eq('id', videoId);
  const business = await getBusiness(businessId);
  bindUsageToBusiness(businessId);
  const product = await getProduct(row.product_id as string);
  const plan = PLANS[business.subscription_tier];
  const theme: StudioTheme = plan.themes ? business.studio_theme : 'clean_minimalist';
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `unb-${videoId.slice(0, 8)}-`));

  try {
    // Step 1 — studio enhancement (parallel, keep originals on failure)
    const funded = row.credit_funded === true;           // paid with a bought credit → full-length video, small watermark
    const mini = !funded && plan.videoLength === 'mini';
    const raw = photosForVideo(row.raw_image_urls as string[], mini, { full: env.VIDEO_MAX_PHOTOS_FULL, mini: env.VIDEO_MAX_PHOTOS_MINI }); // fewer photos = fewer image-model calls = cheaper
    const cleanedPaths: string[] = [];
    // A remake of the same photos (e.g. the Yoruba version) reuses the photos already cleaned for an earlier video: no second ~₦60 per photo.
    const earlier = await priorCleaned(businessId, row.product_id as string, row.raw_image_urls as string[], videoId);
    // A RETRY of this same job (the queue tries a failed render twice) must not pay again for photos it already cleaned on the first try.
    const own = (row.cleaned_image_urls as string[] | null) ?? [];
    for (let i = 0; i < raw.length; i++) if (own[i]) earlier[i] = own[i]!;
    const localImages = await Promise.all(raw.map(async (p, i) => {
      if (earlier[i]) {
        try {
          const data = await downloadFile('cleaned-images', earlier[i]!);
          const reusedExt = earlier[i]!.split('.').pop()?.toLowerCase() ?? 'png';
          const reused = path.join(workDir, `img${i}.${reusedExt}`);
          await fs.writeFile(reused, data);
          cleanedPaths[i] = earlier[i]!;
          return reused;
        } catch { /* the file is gone: clean it again below */ }
      }
      const data = await downloadFile('raw-images', p);
      const ext = p.split('.').pop()?.toLowerCase() ?? 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const enhanced = await enhanceProductPhoto({ data, mimeType }, theme);
      const outExt = enhanced.mimeType.includes('png') ? 'png' : 'jpg';
      const local = path.join(workDir, `img${i}.${outExt}`);
      await fs.writeFile(local, enhanced.data);
      if (enhanced.enhanced) cleanedPaths[i] = await uploadFile('cleaned-images', `${businessId}/${videoId}-${i}.${outExt}`, enhanced.data, enhanced.mimeType);
      return local;
    }));
    // Keep the list ALIGNED with the photos ('' = used the original) so a later remake knows which photo each cleaned file belongs to.
    await db.from('video_jobs').update({ cleaned_image_urls: Array.from({ length: raw.length }, (_, i) => cleanedPaths[i] ?? '') }).eq('id', videoId);

    // Step 2 — script + Nigerian voiceover
    const price = Number(product.selling_price_ngn) || null;
    const shopPhone = displayPhone(business.sales_phone ?? business.owner_phone);
    const script: VideoScript = await writeVideoScript({
      businessName: business.name, productName: product.name, priceNgn: price, deliveryInfo: row.delivery_info as string | null,
      clearance: row.is_clearance as boolean, pidgin: row.voice_language === 'pidgin', voice: row.voice_language === 'yoruba' ? 'yoruba' : row.voice_language === 'pidgin' ? 'pidgin' : 'english', mini,
    });
    let voicePath: string | null = null;
    try {
      const vo = await synthesizeVoiceover(script.voiceover, { pidgin: script.pidgin, yoruba: row.voice_language === 'yoruba' });
      voicePath = path.join(workDir, `vo.${vo.ext}`);
      await fs.writeFile(voicePath, vo.data);
      const audioPath = await uploadFile('videos', `${businessId}/${videoId}.${vo.ext}`, vo.data, vo.mime);
      await db.from('video_jobs').update({ audio_url: audioPath }).eq('id', videoId);
    } catch (e) {
      console.warn('[video] TTS failed, rendering music-only', e);
      voicePath = null;
    }
    await db.from('video_jobs').update({ promo_hook: script.hook, generated_script: script.voiceover }).eq('id', videoId);

    // Step 3 — assemble
    const outPath = path.join(workDir, 'out.mp4');
    const { bytes } = await renderVideo({
      images: localImages, voiceover: voicePath, bgm: await pickBgm(), captions: script.captions.slice(0, 3),
      priceText: price ? ngn(price) : null, contactPhone: shopPhone, watermark: funded ? 'subtle' : row.include_watermark ? plan.watermark === 'none' ? 'subtle' : plan.watermark : 'none',
      clearance: row.is_clearance as boolean, mini, fontPath: path.resolve(env.FONT_PATH), outPath, workDir,
    });

    // Step 4 — upload & deliver as ONE video message
    const videoPath = await uploadFile('videos', `${businessId}/${videoId}.mp4`, await fs.readFile(outPath), 'video/mp4');
    await db.from('video_jobs').update({ status: 'completed', final_video_url: videoPath }).eq('id', videoId);

    await reply(phone)
      .video(await signedUrl('videos', videoPath, 6 * 3600))
      .text(
        `🎬 *${product.name}*${price ? ` — ${ngn(price)}` : ''}`,
        '',
        `👉 Post it to your WhatsApp Status and forward it to customers.${shopPhone ? ` Your number *${shopPhone}* is on the video, so they know where to order.` : ''}`,
        `When someone buys, just tell me: _"sold 1 ${product.name}"_ and I'll log it.`,
        ...(shopPhone ? [`_Wrong number on it? Reply *MY NUMBER 0803 123 4567* and your next videos will use that one._`] : []),
        `_(${(bytes / 1024 / 1024).toFixed(1)}MB — light on data)_`,
        ...(row.voice_language === 'en-NG' ? ['', '🗣️ Want a Yoruba or Pidgin voice? Reply *YORUBA VIDEO* or *PIDGIN VIDEO*.'] : []),
        ...(mini ? ['', '🎞️ This is a ~10-second preview. Starter makes full 15–18 second HD ads.'] : []),
      )
      .send();
  } catch (err) {
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await db.from('video_jobs').update({ status: final ? 'failed' : 'queued', error_message: String(err).slice(0, 2000) }).eq('id', videoId);
    // Tell the platform owner at once (every failed attempt; "will retry" vs "gave up" is spelled out).
    void alertAdmin('video', `Video ${final ? 'FAILED (gave up)' : 'failed (will retry)'}: ${product.name} · ${business.name} (…${phone.slice(-4)})`,
      String(err).split('\n')[0] ?? '', { key: `${videoId}:${job.attemptsMade}`, cooldownS: 3600 });
    void noteGeminiError('video', err);
    if (final) {
      const wasCredit = row.credit_funded === true;
      if (wasCredit) await refundVideoCredit(businessId);
      else { await refundQuota(businessId, 'videos_used_this_month'); await uncountVideoToday(businessId); }
      await reply(phone).text(`😓 Your video for ${product.name} failed to render. It didn't ${wasCredit ? 'use up your video credit' : 'count against your plan'} — send the photos again.`).send().catch(() => undefined);
    }
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Cleaned photos from an earlier completed video of the same product made from exactly the same uploaded photos (else none). */
async function priorCleaned(businessId: string, productId: string, rawUrls: string[], thisVideoId: string): Promise<string[]> {
  try {
    const { data } = await db.from('video_jobs').select('raw_image_urls, cleaned_image_urls')
      .eq('business_id', businessId).eq('product_id', productId).eq('status', 'completed').neq('id', thisVideoId)
      .order('created_at', { ascending: false }).limit(5);
    return reusableCleaned(rawUrls, (data ?? []).map((j) => ({ raw: (j.raw_image_urls as string[] | null) ?? [], cleaned: (j.cleaned_image_urls as string[] | null) ?? [] })));
  } catch { /* no reuse: clean them again */ }
  return [];
}

export function startVideoWorker() {
  // One render at a time by default. os.cpus() reports the HOST's cores inside Railway/Docker (dozens), not this container's
  // 1 GB: sizing by it ran many ffmpegs at once and the kernel killed them (SIGKILL → "video failed to render").
  // Raise VIDEO_CONCURRENCY only after giving the service more RAM (~600 MB per render). Scale out with more PROCESS_ROLE=workers containers.
  return new Worker<VideoJob>(QUEUE.video, processVideo, {
    connection: redisConnection,
    concurrency: Math.max(1, Number(process.env.VIDEO_CONCURRENCY) || 1),
    lockDuration: 5 * 60_000,
  });
}
