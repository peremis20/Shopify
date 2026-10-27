import { formatNumber, formatPct } from "./format";

export const CHANNEL_COLORS = ["#1F4D36", "#B8693D", "#D9A26A", "#EBD3AE", "#8FA89A", "#C9C2B6"];

interface Slice {
  name: string;
  value: number;
  share: number;
}

export function DonutChart({ slices, centerValue, centerLabel }: {
  slices: Slice[];
  centerValue: number;
  centerLabel: string;
}) {
  const r = 62;
  const circ = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
      <div className="relative h-44 w-44 shrink-0">
        <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90" role="img" aria-label="Traffic by channel">
          <circle cx="80" cy="80" r={r} fill="none" stroke="#F1ECE3" strokeWidth="22" />
          {slices.map((s, i) => {
            const len = (s.share / 100) * circ;
            const dash = `${Math.max(0, len - gap)} ${circ}`;
            const el = (
              <circle
                key={s.name}
                cx="80"
                cy="80"
                r={r}
                fill="none"
                stroke={CHANNEL_COLORS[i % CHANNEL_COLORS.length]}
                strokeWidth="22"
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              >
                <title>{`${s.name}: ${formatPct(s.share)}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-serif text-2xl text-dash-ink">{formatNumber(centerValue)}</span>
          <span className="text-xs text-dash-muted">{centerLabel}</span>
        </div>
      </div>

      <ul className="w-full space-y-2.5 text-sm">
        {slices.map((s, i) => (
          <li key={s.name} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-dash-ink">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }} />
              <span className="truncate">{s.name}</span>
            </span>
            <span className="font-medium tabular-nums text-dash-ink">{formatPct(s.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
