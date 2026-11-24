import ffmpeg from 'fluent-ffmpeg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadFile, updateBusiness, uploadFile, type Actor, type Business } from '../db/supabase.js';
import { reply, type Reply } from '../services/whatsapp.js';

/**
 * Receipt branding. businesses.logo_url means:
 *   null  → never asked (the first receipt asks once)
 *   'none' → "use my business name as my logo" (a monogram + the name is drawn)
 *   other → storage path of the uploaded logo (bucket "cleaned-images")
 */
export const LOGO_NONE = 'none';
const BUCKET = 'cleaned-images';
export const AWAIT_LOGO_KEY = (phone: string) => `awaitlogo:${phone}`;
export const AWAIT_LOGO_TTL_S = 15 * 60;

export const hasUploadedLogo = (b: Pick<Business, 'logo_url'>) => !!b.logo_url && b.logo_url !== LOGO_NONE;

/** Logo bytes for the PDF, or null (use the name). Never throws: a missing file must not stop a receipt. */
export async function loadLogo(b: Pick<Business, 'logo_url'>): Promise<Buffer | null> {
  if (!hasUploadedLogo(b)) return null;
  try { return await downloadFile(BUCKET, b.logo_url!); } catch { return null; }
}

/** The one-time question, shown instead of the first receipt. `batchId` lets us carry on to that receipt afterwards. */
export function logoPrompt(phone: string, batchId: string | null): Reply {
  return reply(phone)
    .text(
      '🖼️ *Do you have a logo?*',
      'It goes at the top of your receipts, so customers see your brand.',
      'No logo? No problem: I\'ll use your business name as your logo.',
    )
    .button(`LOGO:ask:${batchId ?? '-'}`, '📷 Send my logo')
    .button(`LOGO:name:${batchId ?? '-'}`, 'Use my name');
}

export function logoAskReply(phone: string): Reply {
  return reply(phone).text('📷 Send your logo now as a photo (a clear, square picture works best). You have 15 minutes.');
}

/** Any phone photo / PNG → a PNG no wider than 480px that pdfkit can embed. Throws if the bytes aren't an image. */
export async function normaliseLogo(data: Buffer): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logo-'));
  const inp = path.join(dir, `in-${crypto.randomBytes(3).toString('hex')}`);
  const out = path.join(dir, 'out.png');
  try {
    await fs.writeFile(inp, data);
    await new Promise<void>((resolve, reject) =>
      ffmpeg(inp).outputOptions(['-frames:v 1', '-vf', "scale='min(480,iw)':-2"]).output(out).on('end', () => resolve()).on('error', (e) => reject(e)).run());
    const png = await fs.readFile(out);
    if (png.length < 100) throw new Error('empty image');
    return png;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Save the owner's logo. Returns the storage path. */
export async function saveLogo(actor: Actor, image: Buffer): Promise<string> {
  const png = await normaliseLogo(image);
  const p = await uploadFile(BUCKET, `${actor.business.id}/logo.png`, png, 'image/png');
  await updateBusiness(actor.business.id, { logo_url: p });
  actor.business.logo_url = p;
  return p;
}

export async function useNameAsLogo(actor: Actor): Promise<void> {
  await updateBusiness(actor.business.id, { logo_url: LOGO_NONE });
  actor.business.logo_url = LOGO_NONE;
}

/** "AsoEwa Fabrics" → "AF"; used for the name-as-logo monogram. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return 'U';
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}
