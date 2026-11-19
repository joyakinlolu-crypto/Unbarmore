import { google, type sheets_v4 } from 'googleapis';
import { env } from '../config/env.js';
import type { TxnRow } from '../db/supabase.js';

let sheets: sheets_v4.Sheets | null = null;

function client(): sheets_v4.Sheets | null {
  if (!env.GOOGLE_SHEETS_SA_JSON_B64) return null;
  if (sheets) return sheets;
  const creds = JSON.parse(Buffer.from(env.GOOGLE_SHEETS_SA_JSON_B64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

export const SHEETS_SERVICE_EMAIL = (() => {
  try {
    return env.GOOGLE_SHEETS_SA_JSON_B64
      ? (JSON.parse(Buffer.from(env.GOOGLE_SHEETS_SA_JSON_B64, 'base64').toString('utf8')).client_email as string)
      : null;
  } catch {
    return null;
  }
})();

export function extractSheetId(urlOrId: string): string | null {
  const m = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) ?? urlOrId.match(/^([a-zA-Z0-9_-]{30,})$/);
  return m?.[1] ?? null;
}

const HEADER = ['Date (WAT)', 'Type', 'Description', 'Category', 'Qty', 'Unit ₦', 'Total ₦', 'Paid ₦', 'Balance ₦', 'Method', 'Customer', 'Logged by', 'Status', 'Txn ID'];

/** Checks we can write, and writes a header row. Owner shares the sheet with SHEETS_SERVICE_EMAIL as Editor. */
export async function connectSheet(sheetId: string): Promise<boolean> {
  const s = client();
  if (!s) return false;
  try {
    await s.spreadsheets.values.update({
      spreadsheetId: sheetId, range: 'A1:N1', valueInputOption: 'RAW', requestBody: { values: [HEADER] },
    });
    return true;
  } catch {
    return false;
  }
}

/** Append confirmed rows; one API call per batch. Best-effort: Sheets is a mirror, Postgres is the truth. */
export async function appendLedgerRows(
  sheetId: string,
  rows: (TxnRow & { customers?: { name: string } | null })[],
  loggedBy: string,
  status: 'confirmed' | 'undone' = 'confirmed',
): Promise<void> {
  const s = client();
  if (!s || !rows.length) return;
  const wat = (iso: string) => new Date(new Date(iso).getTime() + 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  await s.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'A:N',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows.map((r) => [
        wat(r.transaction_date), r.tx_type, r.description, r.category, r.quantity, r.unit_price_ngn ?? '',
        r.total_amount_ngn, r.amount_paid_ngn, r.balance_due_ngn, r.payment_method ?? '', r.customers?.name ?? '',
        loggedBy, status, r.id,
      ]),
    },
  });
}
