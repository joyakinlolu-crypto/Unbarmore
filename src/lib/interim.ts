/**
 * Runs `work`; if it is still running after `ms`, calls `notify` ONCE (e.g. "Processing your entry...").
 * The notice never fires when the work finishes first, and a failing notify can never break the work.
 */
export async function withInterimNotice<T>(work: () => Promise<T>, ms: number, notify: () => void | Promise<void>): Promise<T> {
  // .then(notify) so even a SYNCHRONOUS throw inside notify lands in .catch instead of escaping the timer callback
  const timer = setTimeout(() => { void Promise.resolve().then(notify).catch(() => undefined); }, ms);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}
