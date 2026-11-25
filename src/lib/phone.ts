/** 2348107136951 → "0810 713 6951" (how Nigerians dial it). Returns null for anything that doesn't look like a Nigerian mobile. */
export function displayPhone(e164: string | null | undefined): string | null {
  const d = String(e164 ?? '').replace(/\D/g, '');
  const local = d.startsWith('234') && d.length === 13 ? `0${d.slice(3)}` : d.length === 11 && d.startsWith('0') ? d : null;
  return local ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : null;
}
