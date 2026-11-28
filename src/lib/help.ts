/**
 * The help desk: a picker of the problems owners actually hit, each with a short fix that uses real commands.
 * Pure: no database, no sending. A topic can also be found from free text ("HELP my video did not come").
 */
export interface HelpTopic { id: string; title: string; description: string; steps: string[]; keywords: RegExp }

export const HELP_TOPICS: HelpTopic[] = [
  { id: 'log', title: 'Logging sales & expenses', description: 'It did not understand me, or I made a mistake',
    keywords: /\b(log|sale|sold|expense|voice ?note|understand|wrong entry|mistake|undo|edit|correct)\b/i,
    steps: ['*Logging a sale or expense*', 'Say it the way you would tell a friend. Type or send a voice note:', '_sold 2 bags rice 30k cash, bought fuel 5k_', '', '• Made a mistake? Send *UNDO* within 5 minutes, then send it again correctly.', '• I always show you a summary first. Tap *Confirm* only when it is right, or *Edit* to fix it.', '• Voice note not clear? Speak slowly in one short sentence, or type it.'] },
  { id: 'profit', title: 'My profit looks wrong', description: 'The number is lower or higher than I expected',
    keywords: /\b(profit|looks? wrong|number|total|cash left|margin)\b/i,
    steps: ['*My profit looks wrong*', 'Profit is only as good as what has been logged. Check these:', '', '• *A day with nothing logged* counts as ₦0. Log what you forgot.', '• *Cost prices missing:* tell me what each item costs you, like _lace costs me 15k_. Then profit is exact.', '• *Stock you bought* is not a cost until you sell it. That is correct.', '', 'Under every profit answer I say how many days and records it is based on. If that line looks short, that is the reason.'] },
  { id: 'debt', title: 'Debts and reminders', description: 'Record who owes me, chase, or someone paid',
    keywords: /\b(debt|owe|owes|owing|chase|remind|reminder|paid me|collect)\b/i,
    steps: ['*Debts and reminders*', '• Record: _Femi owes me 14k, Kalu 28k_', '• Someone paid: _Femi paid 5k_', '• Chase: send *CHASE*. I write a polite message for each person and you send it with one tap. *CHASE PIDGIN* or *CHASE YORUBA* for another language.', '• They promised a day? Say _Femi will pay Friday_ and I remind you that morning.', '• See everyone: ask _who owes me?_'] },
  { id: 'video', title: 'Sales videos', description: 'My video did not come, or the voice is missing',
    keywords: /\b(video|videos|voice ?over|photos?|ad|clip)\b/i,
    steps: ['*Sales videos*', '• Send 2 or 3 product photos (together), then the product name and price.', '• A video takes a few minutes. Wait before sending again. Sending again uses up your videos.', '• No voice, or it failed? Send the photos again later. Voices can be busy, and a failed video is not counted against you.', '• Used all your videos? Send *BUY VIDEOS* (from ₦500), or *PLANS*.', '• You can make about 2 included videos a day.'] },
  { id: 'flyer', title: 'Flyers and logo', description: 'Make a flyer, add or make a logo',
    keywords: /\b(flyer|flyers|logo|poster|status)\b/i,
    steps: ['*Flyers and logo*', '• *Flyer:* send one product photo with the caption _flyer Ankara gown 15k_. Add *sale*, *new* or *restock* for a tag, and *green*, *navy* or *wine* for the colour.', '• *Your own logo:* send it as a photo with the word *logo* as the caption.', '• *No logo?* Send *MAKE LOGO* and I will make a simple one for free.', '• Flyer looks off? Use a clear photo with the product in the middle, and keep the name short.'] },
  { id: 'invoice', title: 'Invoices and receipts', description: 'Make one, get paid, add my bank details',
    keywords: /\b(invoice|invoices|receipt|receipts|inv-|bank details|account)\b/i,
    steps: ['*Invoices and receipts*', '• *Invoice:* say _invoice for Mama Tunde 08012345678, 2 lace 50k each_. Add _pay in 2 parts_ for a payment plan.', '• *Customer paid:* send _INV-014 PAID_, or _INV-014 PAID 25000_ for part-payment. The rest becomes their debt.', '• *See open invoices:* send *INVOICES*.', '• *Receipt:* send *RECEIPT* for your last sale.', '• *Bank details and address* printed on them: send *MY ACCOUNT* and *MY ADDRESS*.'] },
  { id: 'plan', title: 'Plan and payment', description: 'My trial, my plan, or I paid but nothing changed',
    keywords: /\b(plan|plans|pay|paid|payment|subscription|trial|upgrade|starter|growth|renew|price)\b/i,
    steps: ['*Plan and payment*', '• See plans and prices: send *PLANS*.', '• Your trial gives you everything free for 14 days. After that you keep a smaller free plan. Nothing is deleted.', '• *Paid but your plan did not change?* Choose *Talk to a person* and send your payment receipt (a screenshot of the transfer). We will fix it by hand.'] },
  { id: 'app', title: 'The web app and login', description: 'Link expired, or I cannot open my dashboard',
    keywords: /\b(app|web|website|dashboard|login|log in|link|expired|charts?|open)\b/i,
    steps: ['*The web app and login*', '• Send *DASHBOARD* and I send you a fresh link. Always use the newest link: older ones stop working.', '• The link works for a short time. If it says expired, ask for a new one.', '• Want it like an app? Open it, tap *Add to Home Screen*, then *Turn on my evening alert*.'] },
  { id: 'pause', title: 'Messages & my data', description: 'Pause reminders, or delete my data',
    keywords: /\b(stop|pause|too many|messages?|unsubscribe|delete|privacy|data|spam)\b/i,
    steps: ['*Too many messages, or my data*', '• Pause the 7 AM and 9 PM notes: send *REMINDERS OFF*. Everything else still works. *REMINDERS ON* turns them back.', '• Delete everything about my business: send *DELETE MY DATA*. We delete it within 30 days and confirm here.', '• Your numbers are private to you. We only look at them to fix a problem you report, and every look is recorded.'] },
];

export const PERSON_ID = 'person';

export const topicById = (id: string): HelpTopic | undefined => HELP_TOPICS.find((t) => t.id === id);

/** "HELP" → picker. "HELP my video did not come" → { text }. null = not a help command. */
export function parseHelpCommand(t: string): { text: string } | null {
  const m = t.trim().match(/^(?:help|menu help|need help|i need help)(?:\s*[:,-]?\s+(.+))?$/is);
  if (!m) return null;
  const text = (m[1] ?? '').trim();
  // "help, I sold 3 lace 30k" is a sale with a polite opening, not a help request: let the normal router log it.
  if (/(\d+\s?k\b|₦|\d{4,})/i.test(text)) return null;
  return { text };
}

/** The topic whose keywords match most of the text, or null when nothing fits (then a person should see it). */
export function matchHelpTopic(text: string): HelpTopic | null {
  let best: { t: HelpTopic; n: number } | null = null;
  for (const t of HELP_TOPICS) {
    const n = (text.match(new RegExp(t.keywords.source, 'gi')) ?? []).length;
    if (n > 0 && (!best || n > best.n)) best = { t, n };
  }
  return best?.t ?? null;
}
