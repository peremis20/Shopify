/**
 * Why plan ideas were turned down, in plain words the owner can read at a glance. The reasons come from the
 * checks themselves (the data checks and the second AI's notes); nothing is added. Pure, safe for the browser.
 */
const REASONS: { test: RegExp; text: (n: number) => string }[] = [
  { test: /^Dropped: what it rests on isn't in this week's data/, text: (n) => `${n} ${n === 1 ? "wasn't" : "weren't"} backed by this week's data` },
  { test: /^Dropped: ".*" isn't in the site's data or isn't on topic/, text: (n) => `${n} named a search that isn't in your data or isn't on topic` },
  { test: /^Dropped: it names no search/, text: (n) => `${n} named no search to work on` },
  { test: /^\s*$/, text: (n) => `${n} got no verdict from the second AI, so ${n === 1 ? "it was" : "they were"} left out` },
];
const OTHER = (n: number) => `${n} ${n === 1 ? "was" : "were"} judged unsupported by the second AI`;
const DEFERRED = /^Left for next week/;

/** True when a move passed every check and only waits for room in next week's plan. */
export const isDeferred = (m: { kept: boolean; challenge?: string | null }) => !m.kept && DEFERRED.test(m.challenge ?? "");

export function droppedSummary(
  moves: { kept: boolean; challenge?: string | null }[],
  opts: { label?: string; closing?: boolean } = {},
): string | null {
  const dropped = moves.filter((m) => !m.kept && !isDeferred(m));
  const deferred = moves.filter(isDeferred).length;
  const out: string[] = [];
  if (dropped.length) {
    const counts = new Map<number, number>();
    for (const m of dropped) {
      const i = REASONS.findIndex((r) => r.test.test(m.challenge ?? ""));
      counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => (i < 0 ? OTHER(n) : REASONS[i].text(n)));
    const n = dropped.length;
    const head = `${opts.label ?? ""}${n} ${n === 1 ? "idea was" : "ideas were"} turned down`;
    out.push(n === 1 ? `${head}: it ${parts[0].replace(/^1 /, "")}.` : `${head}: ${parts.join(", ")}.`);
    if (opts.closing !== false) out.push("Only moves your own numbers back are acted on.");
  }
  if (deferred) out.push(`${deferred} more backed ${deferred === 1 ? "idea waits" : "ideas wait"} for next week because five moves are already planned.`);
  return out.length ? out.join(" ") : null;
}

/** The reason shown next to one turned down idea; never blank. */
export const dropReason = (challenge?: string | null) => (challenge?.trim() ? challenge : "No reason was given.");
