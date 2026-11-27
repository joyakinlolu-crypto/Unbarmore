import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ngn } from '../lib/money.js';

/**
 * Free marketing images, drawn with FFmpeg (already installed for videos) and the bundled DejaVu font: no AI, no cost per image.
 *  - renderFlyer: a 9:16 "AVAILABLE NOW" picture for WhatsApp Status, from the owner's own product photo
 *  - renderLogo: a clean initials logo for people who don't have one
 */
const run = promisify(execFile);
const FONT = path.resolve('assets/fonts/DejaVuSans-Bold.ttf');

export const PALETTES = [
  { name: 'Green', bg: '0x0B3D2E', accent: '0xFFD23F', ink: '0x0B1F17' },
  { name: 'Navy', bg: '0x14213D', accent: '0xFCA311', ink: '0x14213D' },
  { name: 'Wine', bg: '0x6D1A36', accent: '0xF4D35E', ink: '0x3B0A1C' },
] as const;

/** Break a name into at most `maxLines` lines of about `width` characters, never cutting inside a word unless one word is too long. */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    if (w.length > width) w = w.slice(0, width - 1) + '…';
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const kept = lines.slice(0, maxLines); kept[maxLines - 1] = kept[maxLines - 1]!.replace(/…?$/, '…'); return kept; }
  return lines;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export interface FlyerInput {
  photo: Buffer; businessName: string; product: string; priceNgn: number | null;
  contact: string | null; logo?: Buffer | null; footer: boolean; palette?: number;
}

export async function renderFlyer(i: FlyerInput): Promise<Buffer> {
  const pal = PALETTES[(i.palette ?? 0) % PALETTES.length]!;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyer-'));
  try {
    const f = (n: string) => path.join(dir, n);
    const write = async (name: string, text: string) => { await fs.writeFile(f(name), text); return f(name); };
    await fs.writeFile(f('photo'), i.photo);
    const hasLogo = !!i.logo;
    if (hasLogo) await fs.writeFile(f('logo'), i.logo!);

    const biz = clip(i.businessName.trim(), 28);
    const bizSize = biz.length <= 16 ? 64 : biz.length <= 22 ? 54 : 46;
    const nameLines = wrapText(i.product, 20, 2);
    const oneShort = nameLines.length === 1 && nameLines[0]!.length <= 14;
    const nameSize = oneShort ? 84 : 66, lineH = nameSize + 14;

    const draws: string[] = [];
    const text = async (name: string, t: string, size: number, y: number, color: string, extra = '') => {
      const tf = await write(name, t);
      draws.push(`drawtext=fontfile=${FONT}:textfile=${tf}:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}${extra}`);
    };
    await text('biz.txt', biz, bizSize, 70, 'white');
    await text('tag.txt', 'AVAILABLE NOW', 46, 170, pal.ink, `:box=1:boxcolor=${pal.accent}:boxborderw=16`);
    let y = 1330;
    for (const [n, line] of nameLines.entries()) { await text(`n${n}.txt`, line, nameSize, y, 'white'); y += lineH; }
    if (i.priceNgn && i.priceNgn > 0) { await text('price.txt', ngn(i.priceNgn), 110, y + 24, pal.ink, `:box=1:boxcolor=${pal.accent}:boxborderw=28`); y += 200; }
    await text('cta.txt', i.contact ? `Order on WhatsApp: ${i.contact}` : 'Message me on WhatsApp to order', i.contact ? 46 : 44, Math.max(y + 60, 1690), 'white');
    if (i.footer) await text('foot.txt', 'Made with Unbarmore', 30, 1846, 'white@0.55');

    const chain = [
      `[1:v]scale=920:960:force_original_aspect_ratio=decrease[ph]`,
      `[0:v]drawbox=x=60:y=300:w=960:h=1000:color=white:t=fill${hasLogo ? ',drawbox=x=44:y=44:w=142:h=142:color=white:t=fill' : ''}[b0]`,
      `[b0][ph]overlay=(W-w)/2:300+(1000-h)/2[b1]`,
      ...(hasLogo ? [`[2:v]scale=130:130:force_original_aspect_ratio=decrease[lg]`, `[b1][lg]overlay=50:50[b2]`] : []),
      `[${hasLogo ? 'b2' : 'b1'}]${draws.join(',')}[out]`,
    ].join(';');
    const out = f('out.png');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${pal.bg}:s=1080x1920:d=1`, '-i', f('photo'), ...(hasLogo ? ['-i', f('logo')] : []),
      '-filter_complex', chain, '-map', '[out]', '-frames:v', '1', out], { timeout: 30_000 });
    const png = await fs.readFile(out);
    if (png.length < 1000) throw new Error('flyer render produced an empty image');
    return png;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** 512×512 initials logo. Works as a receipt/quote logo and as a WhatsApp profile picture. */
export async function renderLogo(initials: string, palette = 0): Promise<Buffer> {
  const pal = PALETTES[palette % PALETTES.length]!;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logo-'));
  try {
    const tf = path.join(dir, 'i.txt');
    await fs.writeFile(tf, initials.slice(0, 3).toUpperCase());
    const out = path.join(dir, 'out.png');
    const vf = `drawbox=x=0:y=432:w=512:h=80:color=${pal.accent}:t=fill,drawtext=fontfile=${FONT}:textfile=${tf}:fontsize=${initials.length > 2 ? 190 : 230}:fontcolor=white:x=(w-text_w)/2:y=(432-text_h)/2`;
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${pal.bg}:s=512x512:d=1`, '-vf', vf, '-frames:v', '1', out], { timeout: 20_000 });
    return await fs.readFile(out);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

