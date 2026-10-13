'use client';
import { useEffect, useRef, useState } from 'react';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(min: number, max: number, count = 4) {
  if (min === max) max = min + 1;
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export interface LineSeries {
  key: string;
  label: string;
  color: string; // CSS var reference, e.g. var(--series-1)
  values: number[];
}

/**
 * Multi-series line chart on ONE shared y-axis (same unit). Crosshair + tooltip on hover,
 * legend + end-of-line direct labels, optional table view.
 */
export function LineChart({ labels, series, format, height = 220, title }: { labels: string[]; series: LineSeries[]; format: (n: number) => string; height?: number; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const m = { l: 56, r: 72, t: 8, b: 24 };
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const y0 = ticks[0]!;
  const y1 = ticks[ticks.length - 1]!;
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const x = (i: number) => m.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v: number) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 80))));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink2">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <button className="ml-auto underline" onClick={() => setTable(!table)}>{table ? 'Show chart' : 'Show table'}</button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full">
            <thead><tr><th className="th">Period</th>{series.map((s) => <th key={s.key} className="th num">{s.label}</th>)}</tr></thead>
            <tbody>{labels.map((l, i) => <tr key={l}><td className="td">{l}</td>{series.map((s) => <td key={s.key} className="td num">{format(s.values[i] ?? 0)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative">
          <svg width={width} height={height} role="img" aria-label={title}
            onMouseMove={(e) => {
              const rx = e.clientX - (e.currentTarget.getBoundingClientRect().left);
              const i = Math.round(((rx - m.l) / iw) * (labels.length - 1));
              setHover(i >= 0 && i < labels.length ? i : null);
            }}
            onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--line)'} strokeWidth={1} />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{format(t)}</text>
              </g>
            ))}
            {labels.map((l, i) => (i % step === 0 ? <text key={l} x={x(i)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--text-muted)">{l}</text> : null))}
            {series.map((s) => (
              <g key={s.key}>
                <path d={s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {s.values.length > 0 && (
                  <text x={x(s.values.length - 1) + 6} y={y(s.values[s.values.length - 1]!)} dy="0.32em" fontSize={11} fill="var(--text-secondary)">{s.label}</text>
                )}
              </g>
            ))}
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} stroke="var(--axis)" strokeWidth={1} />
                {series.map((s) => <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />)}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-1 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow"
              style={{ left: Math.min(x(hover) + 10, width - 160) }}>
              <div className="font-medium">{labels[hover]}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-2">
                  <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-ink2">{s.label}</span>
                  <span className="ml-auto pl-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{format(s.values[hover] ?? 0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars, one measure, one hue; labelled categories; hover tooltip; zero baseline. */
export function BarList({ rows, format, title }: { rows: Array<{ label: string; value: number; note?: string }>; format: (n: number) => string; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const hasNeg = rows.some((r) => r.value < 0);
  return (
    <div role="img" aria-label={title} className="space-y-2">
      {rows.map((r, i) => {
        const w = (Math.abs(r.value) / max) * (hasNeg ? 50 : 100);
        return (
          <div key={r.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-sm" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="truncate text-ink2">{r.label}</span>
            <div className="relative h-5">
              {hasNeg && <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: 'var(--axis)' }} />}
              <div
                className="absolute inset-y-0.5"
                style={{
                  background: 'var(--series-1)',
                  width: `${w}%`,
                  left: hasNeg ? (r.value < 0 ? `${50 - w}%` : '50%') : 0,
                  borderRadius: r.value < 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                  opacity: hover === null || hover === i ? 1 : 0.55,
                }}
              />
            </div>
            <span className="w-24 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{format(r.value)}</span>
            {hover === i && r.note && <span className="col-span-3 -mt-1 text-xs text-muted">{r.note}</span>}
          </div>
        );
      })}
    </div>
  );
}
