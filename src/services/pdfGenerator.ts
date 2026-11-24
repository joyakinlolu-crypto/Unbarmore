import PDFDocument from 'pdfkit';
import path from 'node:path';
import { ngn } from '../lib/money.js';

// Bundled DejaVu: built-in PDF fonts (Helvetica) have no ₦ glyph.
const FONT_DIR = path.resolve('assets/fonts');
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

const BRAND = { ink: '#0B1F17', green: '#0E7A4F', muted: '#6B7280', line: '#E5E7EB', stamp: '#0E7A4F', red: '#B42318' };

function render(build: (doc: PDFKit.PDFDocument) => void, size: 'A5' | 'A4'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size, margin: size === 'A5' ? 32 : 48, info: { Producer: 'Unbarmore', Creator: 'unbarmore.com' } });
    doc.registerFont('reg', REG);
    doc.registerFont('bold', BOLD);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

/** Letters for the name-as-logo monogram: "AsoEwa Fabrics" → "AF". */
function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return 'U';
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Brand block: the owner's logo, or (no logo) a green monogram badge. Always followed by the business name. */
function header(doc: PDFKit.PDFDocument, title: string, businessName: string, rcNumber: string | null, logo?: Buffer | null) {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x = doc.page.margins.left;
  const y0 = doc.page.margins.top;
  const S = 40; // logo box
  let drewLogo = false;
  if (logo) {
    try { doc.image(logo, x, y0, { fit: [S, S], valign: 'center' }); drewLogo = true; } catch { /* not a usable image: fall back to the monogram */ }
  }
  if (!drewLogo) {
    doc.roundedRect(x, y0, S, S, 9).fillColor(BRAND.green).fill();
    doc.font('bold').fontSize(16).fillColor('#FFFFFF').text(monogram(businessName), x, y0 + S / 2 - 9, { width: S, align: 'center', lineBreak: false });
  }
  const tx = x + S + 10;
  // Long names shrink (15pt down to 10pt) and, if still too wide, are cut with "…" — never wrapped onto the lines below.
  const maxW = w * 0.62 - S;
  let size = 15; doc.font('bold');
  while (size > 10 && doc.fontSize(size).widthOfString(businessName) > maxW) size -= 0.5;
  let shown = businessName;
  while (shown.length > 3 && doc.fontSize(size).widthOfString(shown) > maxW) shown = shown.slice(0, -2).trimEnd() + '…';
  doc.fontSize(size).fillColor(BRAND.ink).text(shown, tx, y0 + (rcNumber ? 4 : 11), { lineBreak: false });
  if (rcNumber) doc.font('reg').fontSize(8).fillColor(BRAND.muted).text(`RC ${rcNumber}`, tx, y0 + 24, { width: w * 0.5, lineBreak: false });
  doc.font('bold').fontSize(11).fillColor(BRAND.green).text(title, x, y0, { width: w, align: 'right' });
  doc.y = y0 + S + 12;
  doc.moveTo(x, doc.y).lineTo(x + w, doc.y).strokeColor(BRAND.line).stroke();
  doc.x = x;
  doc.moveDown(0.8);
}

/** Invitation printed on customer-facing receipts: the owner's customers are the next owners. Omitted on the no-watermark plan. */
export interface Promo { botNumber: string; referralCode: string }

function footer(doc: PDFKit.PDFDocument, promo?: Promo | null) {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.page.height - doc.page.margins.bottom - 12;
  if (promo) {
    const link = `https://wa.me/${promo.botNumber}?text=${encodeURIComponent(`Hi Unbarmore ${promo.referralCode}`)}`;
    doc.font('bold').fontSize(8).fillColor(BRAND.green)
      .text(`Run your shop on WhatsApp. Try Unbarmore free: wa.me/${promo.botNumber}`, doc.page.margins.left, y - 22, { width: w, align: 'center', lineBreak: false, link, underline: true });
    doc.font('reg').fontSize(7).fillColor(BRAND.muted)
      .text(`Use code ${promo.referralCode} and you both get ₦1,000`, doc.page.margins.left, y - 11, { width: w, align: 'center', lineBreak: false });
  }
  doc.font('reg').fontSize(7).fillColor(BRAND.muted)
    .text('Generated on WhatsApp with Unbarmore · unbarmore.com', doc.page.margins.left, y, { width: w, align: 'center', lineBreak: false });
}

// ───────────── Receipt (A5) ─────────────

export interface ReceiptInput {
  businessName: string;
  rcNumber: string | null;
  receiptNumber: string;
  dateWat: string;
  customerName: string | null;
  lines: { description: string; quantity: number; unitPrice: number | null; amount: number }[];
  amountPaid: number;
  paymentMethod: string;
  staffName?: string | null;
  /** Customer's total outstanding debt AFTER this entry. Omit → falls back to this sale's unpaid part. */
  remainingBalance?: number;
  /** Date the remaining balance is as at, e.g. "20 Nov 2026". */
  balanceAsAt?: string;
  /** Set unless the plan has no watermark. */
  promo?: Promo | null;
  /** Owner's logo (PNG/JPEG bytes). Omitted → the business name is drawn as the logo. */
  logo?: Buffer | null;
}

export function receiptPdf(r: ReceiptInput): Promise<Buffer> {
  return render((doc) => {
    header(doc, `RECEIPT\n#${r.receiptNumber}`, r.businessName, r.rcNumber, r.logo);
    const x = doc.page.margins.left;
    const w = doc.page.width - x - doc.page.margins.right;

    doc.font('reg').fontSize(9).fillColor(BRAND.muted);
    doc.text(`Date: ${r.dateWat}`);
    doc.text(`Customer: ${r.customerName ?? 'Walk-in customer'}`);
    if (r.staffName) doc.text(`Served by: ${r.staffName}`);
    doc.moveDown();

    const cols = [x, x + w * 0.5, x + w * 0.62, x + w * 0.8];
    const row = (cells: string[], font: 'reg' | 'bold', color = BRAND.ink) => {
      const y = doc.y;
      doc.font(font).fontSize(9).fillColor(color);
      doc.text(cells[0]!, cols[0], y, { width: w * 0.48 });
      const h = doc.y - y;
      doc.text(cells[1]!, cols[1], y, { width: w * 0.1, align: 'right' });
      doc.text(cells[2]!, cols[2], y, { width: w * 0.16, align: 'right' });
      doc.text(cells[3]!, cols[3], y, { width: w * 0.2, align: 'right' });
      doc.y = y + Math.max(h, 12) + 4;
      doc.x = x;
    };
    row(['Item', 'Qty', 'Unit', 'Amount'], 'bold', BRAND.muted);
    for (const l of r.lines) row([l.description, String(l.quantity), l.unitPrice ? ngn(l.unitPrice) : '—', ngn(l.amount)], 'reg');

    const total = r.lines.reduce((s, l) => s + l.amount, 0);
    const balance = Math.max(0, total - r.amountPaid);
    doc.moveTo(x, doc.y).lineTo(x + w, doc.y).strokeColor(BRAND.line).stroke();
    doc.moveDown(0.5);
    const kv = (k: string, v: string, bold = false, color = BRAND.ink) => {
      const y = doc.y;
      doc.font(bold ? 'bold' : 'reg').fontSize(bold ? 11 : 9).fillColor(color);
      doc.text(k, x + w * 0.45, y, { width: w * 0.3, align: 'right' });
      doc.text(v, x + w * 0.75, y, { width: w * 0.25, align: 'right' });
      doc.x = x;
    };
    kv('Total', ngn(total), true);
    kv(`Amount paid (${r.paymentMethod})`, ngn(r.amountPaid));
    const remaining = r.remainingBalance ?? balance;

    // Remaining debt balance — always shown, so the customer sees exactly where they stand.
    doc.moveDown(0.6);
    const boxY = doc.y;
    doc.roundedRect(x + w * 0.35, boxY, w * 0.65, 34, 6).fillColor(remaining > 0 ? '#FEF3F2' : '#ECFDF3').fill();
    doc.font('bold').fontSize(9).fillColor(remaining > 0 ? BRAND.red : BRAND.stamp)
      .text(`REMAINING BALANCE${r.balanceAsAt ? ` (as at ${r.balanceAsAt})` : ''}`, x + w * 0.35 + 8, boxY + 6, { width: w * 0.65 - 16 });
    doc.font('bold').fontSize(13).text(remaining > 0 ? ngn(remaining) : 'NIL — fully paid', x + w * 0.35 + 8, boxY + 17, { width: w * 0.65 - 16 });
    doc.y = boxY + 44; doc.x = x;

    // PAID stamp — only when the customer owes nothing.
    if (remaining === 0) {
      const cx = x + w * 0.2;
      const cy = boxY + 20;
      doc.save().rotate(-14, { origin: [cx, cy] });
      doc.roundedRect(cx - 55, cy - 20, 110, 40, 6).lineWidth(2.5).strokeColor(BRAND.stamp).opacity(0.85).stroke();
      doc.font('bold').fontSize(24).fillColor(BRAND.stamp).text('PAID', cx - 55, cy - 13, { width: 110, align: 'center' });
      doc.restore().opacity(1);
    }
    doc.font('reg').fontSize(9).fillColor(BRAND.muted).text('Thank you for your patronage.', x, doc.y + 8, { width: w, align: 'center' });
    footer(doc, r.promo);
  }, 'A5');
}

// ───────────── Weekly statement (A4) ─────────────

export interface StatementInput {
  logo?: Buffer | null;
  businessName: string;
  rcNumber: string | null;
  periodLabel: string;
  revenue: number;
  expenses: number;
  restock: number;
  netProfit: number;
  /** Cost of goods sold; with trueProfit=false the netProfit is only cash left (older database). */
  cogs?: number;
  unpriced?: number;
  trueProfit?: boolean;
  cashIn: number;
  debtCollected: number;
  expenseByCategory: { category: string; amount: number; changePct: number | null }[];
  topProducts: { name: string; qty: number; revenue: number }[];
  debtors: { name: string; amount: number; days: number }[];
  deadStock: { name: string; qty: number; days: number }[];
  valueRecovered: number;
}

export function weeklyStatementPdf(s: StatementInput): Promise<Buffer> {
  return render((doc) => {
    header(doc, `INCOME & EXPENSE STATEMENT\n${s.periodLabel}`, s.businessName, s.rcNumber, s.logo);
    const x = doc.page.margins.left;
    const w = doc.page.width - x - doc.page.margins.right;

    // KPI tiles
    const real = s.trueProfit !== false && s.cogs !== undefined;
    const tiles: [string, number, string][] = real
      ? [
          ['Sales', s.revenue, BRAND.ink],
          ['Cost of goods + running costs', (s.cogs ?? 0) + s.expenses, BRAND.ink],
          [(s.unpriced ?? 0) > 0 ? 'Profit (up to)' : 'Net Profit', s.netProfit, s.netProfit >= 0 ? BRAND.green : BRAND.red],
        ]
      : [
          ['Revenue', s.revenue, BRAND.ink],
          ['Expenses + Stock', s.expenses + s.restock, BRAND.ink],
          ['Cash left (not profit)', s.netProfit, s.netProfit >= 0 ? BRAND.green : BRAND.red],
        ];
    const tw = (w - 16) / 3;
    const ty = doc.y;
    tiles.forEach(([label, v, color], i) => {
      const tx = x + i * (tw + 8);
      doc.roundedRect(tx, ty, tw, 56, 6).fillColor('#F6F8F7').fill();
      doc.font('reg').fontSize(8).fillColor(BRAND.muted).text(label.toUpperCase(), tx + 10, ty + 10, { width: tw - 20 });
      doc.font('bold').fontSize(16).fillColor(color).text(ngn(v), tx + 10, ty + 26, { width: tw - 20 });
    });
    doc.y = ty + 66;
    doc.x = x;
    doc.font('reg').fontSize(8).fillColor(BRAND.muted).text(
      real
        ? `Profit = sales − cost of the goods sold − running costs. Stock bought this period (${ngn(s.restock)}) is stock on the shelf, not a cost.${(s.unpriced ?? 0) > 0 ? ` ${ngn(s.unpriced ?? 0)} of sales have no cost price yet, so the real profit is lower.` : ''}`
        : 'Cash left = sales − expenses − stock bought. Cost prices are not set up yet, so this is not true profit.',
      x, doc.y, { width: w },
    );
    doc.moveDown(0.4);

    const section = (title: string) => {
      doc.moveDown(0.6);
      doc.font('bold').fontSize(11).fillColor(BRAND.ink).text(title, x);
      doc.moveDown(0.3);
    };
    const line = (left: string, right: string, color = BRAND.ink) => {
      const y = doc.y;
      doc.font('reg').fontSize(9).fillColor(color).text(left, x, y, { width: w * 0.7 });
      doc.text(right, x + w * 0.7, y, { width: w * 0.3, align: 'right' });
      doc.x = x;
    };

    section('Cash movement');
    line('Cash & transfers received', ngn(s.cashIn));
    line('…of which old debts collected', ngn(s.debtCollected));
    if (s.valueRecovered > 0) line('Margin protected by Inflation Shield (all-time)', ngn(s.valueRecovered), BRAND.green);

    if (s.expenseByCategory.length) {
      section('Expenses by category');
      for (const e of s.expenseByCategory) {
        const flag = e.changePct !== null && e.changePct > 20 ? `  ▲ ${Math.round(e.changePct)}% vs last week` : '';
        line(`${e.category}${flag}`, ngn(e.amount), flag ? BRAND.red : BRAND.ink);
      }
    }
    if (s.topProducts.length) {
      section('Best sellers');
      for (const p of s.topProducts) line(`${p.name} × ${p.qty}`, ngn(p.revenue));
    }
    if (s.debtors.length) {
      section('Customers owing you');
      for (const d of s.debtors) line(`${d.name} (${d.days} days)`, ngn(d.amount), d.days > 14 ? BRAND.red : BRAND.ink);
    }
    if (s.deadStock.length) {
      section('Dead stock (no sale in 21+ days)');
      for (const d of s.deadStock) line(`${d.name} — ${d.qty} left`, `${d.days} days`);
    }
    footer(doc);
  }, 'A4');
}
