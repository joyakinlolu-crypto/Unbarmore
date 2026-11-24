import { ngn, ngnShort } from '@/lib/format';
import type { Bar, Slice, TrendPoint } from '@/lib/analytics';

/* Dependency-free SVG/HTML charts. Server components: they ship no JavaScript. Every chart also prints its numbers as text. */

export function HBars({ rows, color = '#2563EB', label }: { rows: Bar[]; color?: string; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.some((r) => r.value > 0)) return <Empty />;
  return (
    <ul className="space-y-2.5" aria-label={label}>
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex justify-between gap-3 text-sm"><span className="truncate">{r.label}{r.sub && <span className="text-xs text-slate-400"> · {r.sub}</span>}</span><b className="shrink-0">{ngn(r.value)}</b></div>
          <div className="mt-1 h-2 rounded-full bg-mist"><div className="h-2 rounded-full" style={{ width: `${Math.max(3, (r.value / max) * 100)}%`, background: color }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function Columns({ rows, label, highlight = true }: { rows: Bar[]; label: string; highlight?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.some((r) => r.value > 0)) return <Empty />;
  const best = rows.reduce((b, r, i) => (r.value > rows[b]!.value ? i : b), 0);
  return (
    <div role="img" aria-label={label} className="flex h-40 items-end gap-2">
      {rows.map((r, i) => (
        <div key={r.label} className="flex flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[10px] text-slate-500">{r.value > 0 ? ngnShort(r.value) : ''}</span>
          <div className="w-full rounded-t-md" style={{ height: `${Math.max(2, (r.value / max) * 100)}px`, background: highlight && i === best ? '#16A34A' : '#93C5FD' }} />
          <span className="text-[11px] text-slate-500">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Sales (blue) and profit (green) lines over time; a profit below zero dips under the axis line. */
export function TrendLine({ points }: { points: TrendPoint[] }) {
  if (!points.some((p) => p.revenue || p.spend)) return <Empty />;
  const W = 600, H = 190, padL = 46, padB = 22, padT = 10;
  const lo = Math.min(0, ...points.map((p) => p.profit)); const hi = Math.max(1, ...points.map((p) => Math.max(p.revenue, p.profit)));
  const plotH = H - padB - padT; const slot = (W - padL) / Math.max(1, points.length - 1);
  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH; const x = (i: number) => padL + (points.length === 1 ? (W - padL) / 2 : i * slot);
  const line = (k: 'revenue' | 'profit') => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sales and profit over time">
        {[lo, (lo + hi) / 2, hi].map((v, i) => <g key={i}><line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="#E2E8F0" /><text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#94A3B8">{ngnShort(v)}</text></g>)}
        {lo < 0 && <line x1={padL} x2={W} y1={y(0)} y2={y(0)} stroke="#94A3B8" strokeDasharray="4 3" />}
        <path d={line('revenue')} fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinejoin="round" />
        <path d={line('profit')} fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => (i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 5) === 0) && <text key={i} x={x(i)} y={H - 5} textAnchor="middle" fontSize="11" fill="#94A3B8">{p.label}</text>)}
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent" />Sales</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-profit" />Profit</span></div>
    </div>
  );
}

export function Stack({ slices, label }: { slices: Slice[]; label: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (!total) return <Empty />;
  return (
    <div>
      <div role="img" aria-label={label} className="flex h-5 overflow-hidden rounded-full">{slices.map((s) => <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${ngn(s.value)}`} />)}</div>
      <ul className="mt-3 space-y-1.5 text-sm">{slices.map((s) => <li key={s.label} className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span><span><b>{ngn(s.value)}</b> <span className="text-xs text-slate-400">{Math.round((s.value / total) * 100)}%</span></span></li>)}</ul>
    </div>
  );
}

export function Compare({ rows }: { rows: { label: string; cur: number; prev: number }[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.cur), Math.abs(r.prev)]));
  if (rows.every((r) => !r.cur && !r.prev)) return <Empty />;
  return (
    <ul className="space-y-3" aria-label="This period against the one before">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="mb-1 font-medium">{r.label}</div>
          {([['This period', r.cur, '#2563EB'], ['Before', r.prev, '#CBD5E1']] as const).map(([name, v, c]) => (
            <div key={name} className="flex items-center gap-2"><span className="w-20 shrink-0 text-xs text-slate-500">{name}</span><div className="h-2.5 flex-1 rounded-full bg-mist"><div className="h-2.5 rounded-full" style={{ width: `${Math.max(2, (Math.abs(v) / max) * 100)}%`, background: v < 0 ? '#E11D48' : c }} /></div><b className="w-24 shrink-0 text-right text-xs">{ngn(v)}</b></div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function Empty() { return <p className="py-6 text-center text-sm text-slate-400">Nothing to chart in this period yet.</p>; }
