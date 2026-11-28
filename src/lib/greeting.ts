/** A bare "hi" / "good morning" needs no AI call: answer from a fixed, friendly template. Pure. */
const GREETING = /^(?:hi+|hey+|hello+|hola|howdy|yo|sup|good (?:morning|afternoon|evening|day)|gm|how far|how are you|how you dey|wetin dey|e kaaro|e kaasan|e kaale|ina kwana|nnoo)[\s.!?,]*$/i;
export const isGreeting = (t: string): boolean => GREETING.test(t.trim());

/** What Unbarmore does, in one breath, and three things to try. No city, no jargon. */
export function welcomeLines(shop: string): string[] {
  return [
    `👋 Hello, *${shop}*!`,
    'I remember what is easy to forget in your business, so you stop losing money.',
    '',
    'Try one:',
    '• Tell me a sale: _sold 2 bags rice 30k cash_',
    '• Tap *Chase debts* and I will write the reminder for each person who owes you',
    '• Stuck? Tap *Help*. Want the full list? Send *MENU*.',
  ];
}
