import 'server-only';

export async function sendWhatsAppText(to: string, body: string): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION ?? 'v23.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }),
  });
  return res.ok;
}

export const botNumber = () => process.env.WHATSAPP_DISPLAY_NUMBER ?? '';
export const appUrl = () => (process.env.APP_URL ?? 'https://app.unbarmore.com').replace(/\/$/, '');
