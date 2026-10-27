"use client";

import { useEffect, useRef, useState } from "react";
import { formatCompact, formatNumber, formatShortDate } from "./format";

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
  /** Plot against a second scale on the right, for metrics of a different size. */
  axis?: "left" | "right";
}

interface Props {
  dates: string[];
  series: ChartSeries[];
  height?: number;
}

const TICKS = 4;

function niceMax(max: number): number {
  if (max <= 0) return TICKS;
  const rough = max / TICKS;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough)!;
  return step * TICKS;
}

export function LineChart({ dates, series, height = 240 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasRight = series.some((s) => s.axis === "right");
  const pad = { top: 12, right: hasRight ? 46 : 12, bottom: 28, left: 44 };
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const n = dates.length;

  const axisMax = (axis: "left" | "right") =>
    niceMax(
      Math.max(0, ...series.filter((s) => (s.axis ?? "left") === axis).flatMap((s) => s.values))
    );
  const max = { left: axisMax("left"), right: axisMax("right") };

  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number, axis: "left" | "right") => pad.top + innerH - (v / max[axis]) * innerH;

  const labelCount = Math.min(n, Math.max(2, Math.floor(innerW / 80)));
  const labelIdx = Array.from({ length: labelCount }, (_, k) =>
    Math.round((k / Math.max(1, labelCount - 1)) * (n - 1))
  );

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left - pad.left) / innerW;
    setHover(Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))));
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <svg
        width={width}
        height={height}
        className="block overflow-visible"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${series.map((s) => s.label).join(" and ")} over time`}
      >
        {Array.from({ length: TICKS + 1 }, (_, t) => {
          const frac = t / TICKS;
          const yy = pad.top + innerH - frac * innerH;
          return (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + innerW} y1={yy} y2={yy} stroke="#ECE5D8" />
              <text x={pad.left - 8} y={yy} dy="0.32em" textAnchor="end" className="fill-dash-muted text-[11px]">
                {formatCompact(max.left * frac)}
              </text>
              {hasRight && (
                <text x={pad.left + innerW + 8} y={yy} dy="0.32em" className="fill-dash-muted text-[11px]">
                  {formatCompact(max.right * frac)}
                </text>
              )}
            </g>
          );
        })}

        {labelIdx.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 8}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            className="fill-dash-muted text-[11px]"
          >
            {formatShortDate(dates[i])}
          </text>
        ))}

        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="#CFC6B6" strokeDasharray="3 3" />
        )}

        {series.map((s) => {
          const axis = s.axis ?? "left";
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v, axis).toFixed(1)}`).join("");
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && (
                <circle cx={x(hover)} cy={y(s.values[hover], axis)} r={4} fill="#fff" stroke={s.color} strokeWidth={2} />
              )}
            </g>
          );
        })}
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-[140px] rounded-lg border border-dash-line bg-white px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(x(hover) - 70, 0), width - 150),
          }}
        >
          <p className="mb-1 font-semibold text-dash-ink">{formatShortDate(dates[hover])}</p>
          {series.map((s) => (
            <p key={s.label} className="flex items-center justify-between gap-3 text-dash-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-medium text-dash-ink">{formatNumber(s.values[hover])}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-dash-muted">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
