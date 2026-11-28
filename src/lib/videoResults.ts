/** "Did this video bring you a customer?" Pure parts: when to ask, how to word it, what to say back. */
export type VideoResult = 'yes' | 'no' | 'unposted';
export const VIDEO_RESULTS: readonly VideoResult[] = ['yes', 'no', 'unposted'];
export const isVideoResult = (x: unknown): x is VideoResult => VIDEO_RESULTS.includes(x as VideoResult);

const DAY = 86_400_000;
/** Ask once, 3 to 10 days after the video was made (after that the moment has passed and the question feels odd). */
export const FOLLOWUP_FROM_DAYS = 3, FOLLOWUP_TO_DAYS = 10;

export function followupDue(createdAtIso: string, now = Date.now()): boolean {
  const age = now - Date.parse(createdAtIso);
  return age >= FOLLOWUP_FROM_DAYS * DAY && age <= FOLLOWUP_TO_DAYS * DAY;
}

export function followupQuestion(product: string | null, createdAtIso: string, now = Date.now()): string[] {
  const days = Math.max(1, Math.round((now - Date.parse(createdAtIso)) / DAY));
  return [
    `🎬 ${days} days ago I made your${product ? ` *${product}*` : ''} video.`,
    '*Did it bring you a customer?* One tap and I\'ll know what works for you.',
  ];
}

export function resultAnswer(r: VideoResult): string[] {
  switch (r) {
    case 'yes': return ['🎉 That is exactly what it is for. Tell me what they bought and I\'ll record the sale, so it counts in your profit.'];
    case 'no': return ['Thanks for telling me. Videos work best when they reach people who already know you: post it on your WhatsApp Status and send it straight to a few past customers. Say *WIN BACK* and I\'ll write the message for you.'];
    case 'unposted': return ['No wahala. It only works once it is seen: post it on your WhatsApp Status today and send it to a few past customers. Say *WIN BACK* and I\'ll write the message for you.'];
  }
}
