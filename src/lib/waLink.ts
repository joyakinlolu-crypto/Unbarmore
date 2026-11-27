/** Nigerian phone numbers → wa.me chat links with the message already typed. The owner taps, WhatsApp opens, they press send. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (/^234\d{10}$/.test(d)) return d;
  if (/^0\d{10}$/.test(d)) return '234' + d.slice(1);
  if (/^\d{10}$/.test(d)) return '234' + d;
  return null;
}

/** null when we don't have a usable number for this customer. */
export function waLink(phone: string | null | undefined, message: string): string | null {
  const p = phone ? normalisePhone(phone) : null;
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(message)}` : null;
}
