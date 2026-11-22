import crypto from 'node:crypto';
import { env } from '../config/env.js';

const GRAPH = env.WHATSAPP_GRAPH_BASE ?? `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}`;

// ───────────── Webhook signature ─────────────

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

// ───────────── Inbound payload types (subset we use) ─────────────

export interface WaInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'audio' | 'image' | 'document' | 'interactive' | 'button' | 'video' | 'sticker' | 'location' | 'contacts' | 'reaction' | string;
  text?: { body: string };
  audio?: { id: string; mime_type: string; voice?: boolean };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload: string; text: string }; // quick-reply on a template
  context?: { id: string };
}

export interface WaWebhookBody {
  object: string;
  entry?: {
    changes?: {
      field: string;
      value: {
        messages?: WaInboundMessage[];
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

export function extractMessages(body: WaWebhookBody): { msg: WaInboundMessage; profileName: string | null }[] {
  const out: { msg: WaInboundMessage; profileName: string | null }[] = [];
  for (const e of body.entry ?? []) {
    for (const c of e.changes ?? []) {
      if (c.field !== 'messages') continue;
      const names = new Map((c.value.contacts ?? []).map((ct) => [ct.wa_id, ct.profile?.name ?? null]));
      for (const m of c.value.messages ?? []) out.push({ msg: m, profileName: names.get(m.from) ?? null });
    }
  }
  return out;
}

// ───────────── Low-level send ─────────────

async function graph<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string; code: number } };
  if (!res.ok) {
    const err = new Error(`WhatsApp API ${res.status}: ${json.error?.message ?? 'unknown'}`) as Error & { code?: number };
    err.code = json.error?.code;
    throw err;
  }
  return json;
}

async function sendRaw(to: string, payload: Record<string, unknown>): Promise<string | null> {
  const res = await graph<{ messages?: { id: string }[] }>(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...payload,
  });
  return res.messages?.[0]?.id ?? null;
}

/** Mark read + show "typing…" (free, not a billable message). Gives instant feedback while Gemini thinks. */
export async function markReadWithTyping(messageId: string): Promise<void> {
  await graph(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch(() => undefined);
}

// ───────────── Single-reply bundler ─────────────
//
// RULE: one user action → one outbound message. Everything a reply needs (text, PDF/video, buttons)
// is folded into a single Cloud API call. Interactive messages accept a document/video/image *header*,
// so "confirmation + profit + PDF receipt + buttons" is genuinely one message.

export interface Button { id: string; title: string }
export interface ListRow { id: string; title: string; description?: string }
type Media =
  | { kind: 'document'; link: string; filename: string }
  | { kind: 'video'; link: string }
  | { kind: 'image'; link: string };

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

export class Reply {
  private lines: string[] = [];
  private buttons: Button[] = [];
  private list: { button: string; rows: ListRow[] } | null = null;
  private media: Media | null = null;
  private footerText: string | null = null;
  private replyTo: string | null = null;

  constructor(private readonly to: string) {}

  text(...lines: (string | null | undefined | false)[]): this {
    for (const l of lines) if (l) this.lines.push(l);
    return this;
  }
  button(id: string, title: string): this {
    if (this.buttons.length >= 3) throw new Error('WhatsApp allows max 3 reply buttons');
    this.buttons.push({ id, title: clip(title, 20) });
    return this;
  }
  listMenu(buttonLabel: string, rows: ListRow[]): this {
    this.list = { button: clip(buttonLabel, 20), rows: rows.slice(0, 10) };
    return this;
  }
  document(link: string, filename: string): this { this.media = { kind: 'document', link, filename }; return this; }
  video(link: string): this { this.media = { kind: 'video', link }; return this; }
  image(link: string): this { this.media = { kind: 'image', link }; return this; }
  footer(t: string): this { this.footerText = clip(t, 60); return this; }
  quoting(messageId: string): this { this.replyTo = messageId; return this; }
  get isEmpty(): boolean { return this.lines.length === 0 && !this.media; }

  toPayload(): Record<string, unknown> {
    const body = this.lines.join('\n');
    const context = this.replyTo ? { context: { message_id: this.replyTo } } : {};

    if (this.buttons.length || this.list) {
      const header = this.media
        ? this.media.kind === 'document'
          ? { type: 'document', document: { link: this.media.link, filename: this.media.filename } }
          : { type: this.media.kind, [this.media.kind]: { link: this.media.link } }
        : undefined;
      const action = this.list
        ? {
            button: this.list.button,
            sections: [{ title: 'Options', rows: this.list.rows.map((r) => ({ id: r.id, title: clip(r.title, 24), description: r.description ? clip(r.description, 72) : undefined })) }],
          }
        : { buttons: this.buttons.map((b) => ({ type: 'reply', reply: b })) };
      return {
        ...context,
        type: 'interactive',
        interactive: {
          type: this.list ? 'list' : 'button',
          ...(header && !this.list ? { header } : {}),
          body: { text: clip(body || ' ', 1024) },
          ...(this.footerText ? { footer: { text: this.footerText } } : {}),
          action,
        },
      };
    }
    if (this.media) {
      const caption = clip(body, 1024) || undefined;
      const m = this.media;
      if (m.kind === 'document') return { ...context, type: 'document', document: { link: m.link, filename: m.filename, caption } };
      return { ...context, type: m.kind, [m.kind]: { link: m.link, caption } };
    }
    return { ...context, type: 'text', text: { body: clip(body, 4096), preview_url: false } };
  }

  async send(): Promise<string | null> {
    if (this.isEmpty) return null;
    return sendRaw(this.to, this.toPayload());
  }
}

export const reply = (to: string) => new Reply(to);

// ───────────── Templates (paid; outside 24h window) ─────────────

/**
 * Template components. Button order must match the order defined in Meta Business Manager:
 *   index 0      → dynamic URL button  (https://app.unbarmore.com/auth/verify?token={{1}})
 *   index 1..n   → quick-reply buttons, only if a template defines them
 * The Sunday CEO report uses the URL button ONLY (no quick replies), so it renders on WhatsApp Desktop too.
 */
export function templateComponents(bodyParams: string[], quickReplyPayloads: string[] = [], urlToken?: string): Record<string, unknown>[] {
  const offset = urlToken ? 1 : 0;
  return [
    { type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) },
    ...(urlToken ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: urlToken }] }] : []),
    ...quickReplyPayloads.map((payload, i) => ({
      type: 'button', sub_type: 'quick_reply', index: String(i + offset), parameters: [{ type: 'payload', payload }],
    })),
  ];
}

export async function sendTemplate(
  to: string,
  name: string,
  bodyParams: string[],
  quickReplyPayloads: string[] = [],
  urlToken?: string,
): Promise<string | null> {
  return sendRaw(to, {
    type: 'template',
    template: { name, language: { code: env.WHATSAPP_TEMPLATE_LANG }, components: templateComponents(bodyParams, quickReplyPayloads, urlToken) },
  });
}

// ───────────── Media download ─────────────

export async function downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } });
  if (!metaRes.ok) throw new Error(`media lookup failed ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string; file_size?: number };
  if ((meta.file_size ?? 0) > 20 * 1024 * 1024) throw new Error('media too large');
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } });
  if (!fileRes.ok) throw new Error(`media download failed ${fileRes.status}`);
  return { data: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type.split(';')[0]!.trim() };
}
