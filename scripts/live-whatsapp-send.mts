/**
 * Live outbound test through the app's own Reply builder (single bundled message: text + PDF + buttons).
 *   set -a; . ./.env; set +a; NODE_USE_ENV_PROXY=1 npx tsx scripts/live-whatsapp-send.mts <E164 digits>
 * The recipient must have messaged the number in the last 24h (free-form messages), and be on the test number's allowed list.
 */
const to = process.argv[2];
if (!to || !/^\d{10,15}$/.test(to)) throw new Error('usage: live-whatsapp-send.mts <recipient digits, e.g. 2348012345678>');
const { reply } = await import('../src/services/whatsapp.ts');
const { receiptPdf } = await import('../src/services/pdfGenerator.ts');
const { uploadFile, signedUrl } = await import('../src/db/supabase.ts');

const pdf = await receiptPdf({
  businessName: 'Unbarmore Live Test', rcNumber: null, receiptNumber: '261120-TEST', dateWat: new Date(Date.now() + 3600_000).toISOString().replace('T', ' ').slice(0, 16) + ' WAT',
  customerName: 'Test Customer', lines: [{ description: '2 × Swiss Lace', quantity: 2, unitPrice: 25000, amount: 50000 }], amountPaid: 50000, paymentMethod: 'transfer',
});
const path = `live-test/receipt-${Date.now()}.pdf`;
await uploadFile('pdf-receipts', path, pdf, 'application/pdf');
const link = await signedUrl('pdf-receipts', path, 3600);
console.log('PDF uploaded:', path, `(${pdf.length} bytes)`);

const r = reply(to)
  .text('✅ Saved 2 entries', '📊 Today: Sales ₦50,000 · Spent ₦5,000 · Profit *₦45,000*', '🧾 Receipt attached — forward it to your customer.', '', '_This is a live test of the single-reply bundler._')
  .document(link, 'Receipt-261120-TEST.pdf')
  .button('TEST:undo', '↩️ Undo')
  .button('TEST:menu', '📋 Menu');
console.log('payload type:', (r.toPayload() as { type: string }).type, '→ ONE API call');
const id = await r.send();
console.log('WhatsApp message id:', id);
console.log('STORAGE_PATH=' + path);
