/**
 * One place for the details that appear on the Privacy Policy and Terms of Service.
 * Set these in Vercel (Settings → Environment Variables) so the pages show the REAL legal entity:
 *   NEXT_PUBLIC_LEGAL_NAME, NEXT_PUBLIC_LEGAL_RC, NEXT_PUBLIC_LEGAL_ADDRESS, NEXT_PUBLIC_PRIVACY_EMAIL, NEXT_PUBLIC_WHATSAPP_DISPLAY
 * Anything left unset is simply not shown (we never print placeholders on a public page).
 */
export const LEGAL = {
  product: 'Unbarmore',
  site: 'unbarmore.com',
  company: process.env.NEXT_PUBLIC_LEGAL_NAME || 'Unbarmore',
  rc: process.env.NEXT_PUBLIC_LEGAL_RC || '',
  address: process.env.NEXT_PUBLIC_LEGAL_ADDRESS || '',
  email: process.env.NEXT_PUBLIC_PRIVACY_EMAIL || 'privacy@unbarmore.com',
  whatsapp: process.env.NEXT_PUBLIC_WHATSAPP_DISPLAY || '',
  effective: '26 November 2026',
} as const;

/** Third parties that process data for us (listed in the Privacy Policy). Keep in sync with what the product really uses. */
export const PROCESSORS = [
  { name: 'Meta Platforms (WhatsApp Cloud API)', why: 'delivers your WhatsApp messages, voice notes and photos to us, and our replies to you', where: 'USA / global' },
  { name: 'Google (Gemini API)', why: 'reads your messages, voice notes and photos, writes ad scripts, cleans product photos and speaks the voiceover', where: 'USA / global' },
  { name: 'Supabase', why: 'database and file storage for your records, receipts, photos and videos', where: 'outside Nigeria' },
  { name: 'Railway', why: 'runs the WhatsApp bot and its job queue', where: 'USA' },
  { name: 'Vercel', why: 'hosts this website and the Unbarmore app', where: 'USA / global' },
  { name: 'Paystack', why: 'processes subscription payments and referral payouts', where: 'Nigeria / global' },
] as const;
