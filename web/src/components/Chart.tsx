'use client';
import { useState } from 'react';
import { ngn, ngnShort } from '@/lib/format';

export interface Point { label: string; revenue: number; spend: number }

/** Dependency-free SVG bar chart (recharts alone would be ~100KB of the 500KB budget). Tap/click a day to read it. */
export default function Chart({ data }: { data: Point[] }) {
  const [sel, setSel] = useState<number | null>(null);
  if (!data.length) return <p className="py-10 text-center text-sm text-slate-400">No confirmed records in this period yet.</p>;

  const max = Math.max(1, ...data.flatMap((d) => [d.revenue, d.spend]));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const W = 600, H = 200, padL = 44, padB = 22, plotW = W - padL, plotH = H - padB;
  const slot = plotW / data.length;
  const bw = Math.max(2, Math.min(14, slot * 0.36));
  const y = (v: number) => plotH - (v / top) * plotH;
  const s = sel !== null ? data[sel] : null;

  return (
    <div>
      <div className="mb-2 flex min-h-9 items-center justify-between text-sm" aria-live="polite">
        {s ? (
          <>
            <span className="font-semibold">{s.label}</span>
            <span><b className="text-accent">{ngn(s.revenue)}</b> in · <b className="text-alert">{ngn(s.spend)}</b> out</span>
          </>
        ) : <span className="text-slate-400">Tap a bar for details</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Revenue versus spending">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="#E2E8F0" strokeWidth="1" />
            <text x={padL - 6} y={y(top * f) + 4} textAnchor="end" fontSize="11" fill="#94A3B8">{ngnShort(top * f)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = padL + slot * i + slot / 2;
          return (
            <g key={i} onClick={() => setSel(i === sel ? null : i)} className="cursor-pointer">
              <rect x={padL + slot * i} y={0} width={slot} height={plotH} fill={i === sel ? '#EFF6FF' : 'transparent'} />
              <rect x={cx - bw - 1} y={y(d.revenue)} width={bw} height={plotH - y(d.revenue)} rx="2" fill="#2563EB" />
              <rect x={cx + 1} y={y(d.spend)} width={bw} height={plotH - y(d.spend)} rx="2" fill="#E11D48" opacity="0.85" />
              {(i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 6) === 0) && (
                <text x={cx} y={H - 5} textAnchor="middle" fontSize="11" fill="#94A3B8">{d.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-slate-500">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent" />Sales</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-alert" />Expenses + stock</span>
      </div>
    </div>
  );
}
