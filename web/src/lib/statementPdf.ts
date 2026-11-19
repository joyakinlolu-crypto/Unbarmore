import 'server-only';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { ngn } from './format';

export interface MonthlyStatement {
  businessName: string; rcNumber: string | null; monthLabel: string;
  revenue: number; expenses: number; restock: number; netProfit: number; cashIn: number; debtCollected: number;
  categories: { category: string; amount: number }[];
  topProducts: { name: string; qty: number; revenue: number }[];
  debtors: { name: string; amount: number }[];
}

const FONTS = path.join(process.cwd(), 'assets', 'fonts'); // DejaVu: built-in PDF fonts have no ₦ glyph

export function monthlyStatementPdf(s: MonthlyStatement): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Statement ${s.monthLabel}`, Producer: 'Unbarmore' } });
    doc.registerFont('r', path.join(FONTS, 'DejaVuSans.ttf'));
    doc.registerFont('b', path.join(FONTS, 'DejaVuSans-Bold.ttf'));
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const x = 48, w = doc.page.width - 96;
    doc.font('b').fontSize(18).fillColor('#1E3A8A').text(s.businessName, x, 48);
    if (s.rcNumber) doc.font('r').fontSize(9).fillColor('#64748B').text(`RC ${s.rcNumber}`);
    doc.font('b').fontSize(11).fillColor('#2563EB').text(`INCOME & EXPENSE STATEMENT — ${s.monthLabel}`, x, 48, { width: w, align: 'right' });
    doc.moveDown(2.5);

    const row = (l: string, r: string, bold = false, color = '#1E293B') => {
      const y = doc.y;
      doc.font(bold ? 'b' : 'r').fontSize(10).fillColor(color).text(l, x, y, { width: w * 0.7 });
      doc.text(r, x + w * 0.7, y, { width: w * 0.3, align: 'right' });
      doc.x = x; doc.moveDown(0.35);
    };
    const h = (t: string) => { doc.moveDown(0.8); doc.font('b').fontSize(12).fillColor('#1E3A8A').text(t, x); doc.moveDown(0.4); };

    h('Summary');
    row('Sales (revenue)', ngn(s.revenue));
    row('Operating expenses', ngn(s.expenses));
    row('Stock purchases', ngn(s.restock));
    row('Net profit', ngn(s.netProfit), true, s.netProfit >= 0 ? '#059669' : '#E11D48');
    row('Cash & transfers received', ngn(s.cashIn));
    row('…of which old debts collected', ngn(s.debtCollected));
    if (s.categories.length) { h('Expenses by category'); s.categories.forEach((c) => row(c.category, ngn(c.amount))); }
    if (s.topProducts.length) { h('Best sellers'); s.topProducts.forEach((p) => row(`${p.name} × ${p.qty}`, ngn(p.revenue))); }
    if (s.debtors.length) { h('Customers owing (as of today)'); s.debtors.forEach((d) => row(d.name, ngn(d.amount))); }

    doc.font('r').fontSize(7).fillColor('#94A3B8')
      .text('Generated from records logged on WhatsApp via Unbarmore (unbarmore.com). Figures are owner-reported; not an audited statement.', x, doc.page.height - 60, { width: w, align: 'center' });
    doc.end();
  });
}
