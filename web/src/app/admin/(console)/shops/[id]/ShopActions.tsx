'use client';
import { useActionState } from 'react';
import { compPlan, extendTrial, grantVideos, type ActionResult } from './actions';

const input = 'w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm';
const btn = 'rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';

function Msg({ r }: { r: ActionResult | null }) { return r ? <p className={`mt-1 text-xs ${r.ok ? 'text-emerald-700' : 'text-red-600'}`}>{r.message}</p> : null; }

export default function ShopActions({ id, tier }: { id: string; tier: string }) {
  const [g, gAct, gPend] = useActionState(grantVideos.bind(null, id), null);
  const [t, tAct, tPend] = useActionState(extendTrial.bind(null, id), null);
  const [c, cAct, cPend] = useActionState(compPlan.bind(null, id), null);
  const paid = tier === 'starter_5k' || tier === 'growth_15k';
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <form action={gAct} className="rounded-xl border border-slate-100 p-3"><p className="text-sm font-semibold">Give videos</p>
        <div className="mt-2 flex items-center gap-2"><input name="qty" defaultValue="1" inputMode="numeric" className={input} aria-label="Number of videos" /><button className={btn} disabled={gPend}>Add</button></div><Msg r={g} /></form>
      <form action={tAct} className="rounded-xl border border-slate-100 p-3"><p className="text-sm font-semibold">Extend the trial</p>
        <div className="mt-2 flex items-center gap-2"><input name="days" defaultValue="7" inputMode="numeric" className={input} aria-label="Days" /><span className="text-sm text-slate-500">days</span><button className={btn} disabled={tPend || paid}>Extend</button></div>
        {paid && <p className="mt-1 text-xs text-slate-400">Already on a paid plan.</p>}<Msg r={t} /></form>
      <form action={cAct} className="rounded-xl border border-slate-100 p-3"><p className="text-sm font-semibold">Give a plan free</p>
        <div className="mt-2 flex flex-wrap items-center gap-2"><select name="tier" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><option value="starter_5k">Starter</option><option value="growth_15k">Growth</option></select>
          <input name="days" defaultValue="30" inputMode="numeric" className={input} aria-label="Days" /><span className="text-sm text-slate-500">days</span><button className={btn} disabled={cPend}>Give</button></div><Msg r={c} /></form>
    </div>
  );
}
