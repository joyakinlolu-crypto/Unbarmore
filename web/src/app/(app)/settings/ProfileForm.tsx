'use client';
import { useActionState } from 'react';
import { saveProfile, type SaveResult } from './actions';

const THEMES = [
  ['clean_minimalist', 'Clean minimalist', 'White studio, catalogue look'],
  ['luxury_boutique', 'Luxury boutique', 'Marble, brass, spotlight'],
  ['outdoor_lifestyle', 'Outdoor lifestyle', 'Golden-hour, greenery'],
] as const;

export default function ProfileForm({ name, rc, theme, themesLocked }: { name: string; rc: string; theme: string; themesLocked: boolean }) {
  const [res, action, pending] = useActionState<SaveResult | null, FormData>(saveProfile, null);
  const field = 'mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-base outline-none focus:border-accent';
  return (
    <form action={action} className="space-y-4">
      <label className="block text-sm font-medium">Business name<input name="name" defaultValue={name} required minLength={2} maxLength={80} className={field} /></label>
      <label className="block text-sm font-medium">RC number <span className="font-normal text-slate-400">(optional, shown on receipts)</span>
        <input name="rc" defaultValue={rc} inputMode="numeric" placeholder="1234567" className={field} /></label>
      <fieldset disabled={themesLocked} className="space-y-2">
        <legend className="text-sm font-medium">Video studio theme {themesLocked && <span className="font-normal text-slate-400">· paid plans</span>}</legend>
        {THEMES.map(([v, l, d]) => (
          <label key={v} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 has-[:checked]:border-accent has-[:checked]:bg-blue-50">
            <input type="radio" name="theme" value={v} defaultChecked={theme === v} className="accent-accent" />
            <span><span className="block text-sm font-medium">{l}</span><span className="block text-xs text-slate-500">{d}</span></span>
          </label>
        ))}
      </fieldset>
      <button disabled={pending} className="w-full rounded-xl bg-royal py-3.5 font-semibold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Save changes'}</button>
      {res && <p role="status" className={`text-sm ${res.ok ? 'text-profit' : 'text-alert'}`}>{res.message}</p>}
    </form>
  );
}
