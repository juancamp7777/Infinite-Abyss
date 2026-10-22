"use client";

export interface Series {
  label: string;
  color: string;
  values: number[];
}

const W = 640;
const H = 220;
const PAD = { l: 48, r: 12, t: 12, b: 24 };

function scale(series: Series[]) {
  const all = series.flatMap((s) => s.values);
  let min = Math.min(0, ...all);
  let max = Math.max(0, ...all);
  if (min === max) max = min + 1;
  const pad = (max - min) * 0.05;
  if (min < 0) min -= pad;
  max += pad;
  return { min, max };
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(Math.abs(n) < 10 && n % 1 !== 0 ? 1 : 0));

function Axes({ min, max, labels }: { min: number; max: number; labels: string[] }) {
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const ticks = [0, 1, 2, 3, 4].map((i) => min + ((max - min) * i) / 4);
  const step = Math.max(1, Math.ceil(labels.length / 6));
  return (
    <g className="text-[10px]" fill="currentColor">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={0.12} />
          <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" opacity={0.6}>
            {fmt(t)}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        i % step === 0 ? (
          <text key={l + i} x={PAD.l + (i / Math.max(1, labels.length - 1)) * (W - PAD.l - PAD.r)} y={H - 6} textAnchor="middle" opacity={0.6}>
            {l.slice(5)}
          </text>
        ) : null,
      )}
    </g>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-3 text-xs text-white/70">
      {series.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Gráfico de líneas SVG propio. `title` alimenta el texto alternativo. */
export function LineChart({ series, labels, title }: { series: Series[]; labels: string[]; title: string }) {
  if (labels.length === 0) return null;
  const { min, max } = scale(series);
  const x = (i: number) => PAD.l + (labels.length === 1 ? 0.5 : i / (labels.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full text-white">
        <title>{title}</title>
        <Axes min={min} max={max} labels={labels} />
        {series.map((s) => (
          <polyline key={s.label} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        ))}
      </svg>
      <Legend series={series} />
    </figure>
  );
}

/** Barras agrupadas SVG propias (positivas y negativas). */
export function BarChart({ series, labels, title }: { series: Series[]; labels: string[]; title: string }) {
  if (labels.length === 0) return null;
  const { min, max } = scale(series);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const slot = (W - PAD.l - PAD.r) / labels.length;
  const bw = Math.max(1, (slot * 0.8) / series.length);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full text-white">
        <title>{title}</title>
        <Axes min={min} max={max} labels={labels} />
        {labels.map((l, i) =>
          series.map((s, j) => {
            const v = s.values[i] ?? 0;
            const y0 = y(0);
            const y1 = y(v);
            return <rect key={`${l}-${s.label}`} x={PAD.l + i * slot + slot * 0.1 + j * bw} y={Math.min(y0, y1)} width={bw} height={Math.max(1, Math.abs(y0 - y1))} fill={s.color} rx={1} />;
          }),
        )}
      </svg>
      <Legend series={series} />
    </figure>
  );
}
