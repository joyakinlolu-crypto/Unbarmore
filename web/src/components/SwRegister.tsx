'use client';
import { useEffect } from 'react';

/** Starts the service worker (offline page, fast repeat opens, and the evening alerts). Production only: in dev it would cache stale code. */
export default function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
