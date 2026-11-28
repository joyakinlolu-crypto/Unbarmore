import { displayPhone } from './phone.js';

/** "Tel 0803 123 4567 · 12 Bode Street, Ibadan": the issuer's contact line printed under the business name on receipts and invoices. null when there is nothing to print. */
export function businessContact(b: { sales_phone?: string | null; owner_phone?: string | null; address?: string | null }): string | null {
  const phone = displayPhone(b.sales_phone ?? b.owner_phone);
  const bits = [phone ? `Tel ${phone}` : '', (b.address ?? '').trim()].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

/** "Mama Tunde · 0803 123 4567" for the person a document is addressed to. */
export function personLine(name: string | null, phone: string | null | undefined): string | null {
  const p = displayPhone(phone);
  return [name?.trim(), p].filter(Boolean).join(' · ') || null;
}
