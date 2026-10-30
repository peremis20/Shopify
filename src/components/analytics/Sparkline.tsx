export function Sparkline({ values, color = "#1F4D36" }: { values: number[]; color?: string }) {
  // A flat line (no change, or no data yet) says nothing, so draw nothing.
  if (values.length < 2 || values.every((v) => v === values[0])) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 36 - ((v - min) / span) * 32]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const id = `spark-${color.replace("#", "")}`;

  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-24 shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line}L100,40L0,40Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
