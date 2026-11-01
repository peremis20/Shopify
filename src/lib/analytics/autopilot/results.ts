import { ensureSchema, sql } from "../db";

/**
 * What the agents' own changes did on this site, measured: Google position and clicks before a change and
 * four weeks after it. This is the data every agent learns from (no opinions). Only this site's changes count.
 */
const LABEL: Record<string, string> = {
  meta_title: "SEO titles",
  meta_description: "meta descriptions",
  content: "new sections on pages",
  internal_link: "links between pages",
  new_article: "new articles",
  schema: "structured data",
  alt: "image alt text",
};

export async function measuredResults(accountId: string): Promise<string[]> {
  await ensureSchema();
  // Counted from Google's numbers at measurement time (before and four weeks after), never from whether a change was
  // later kept or undone: an owner's undo, a failed or skipped undo, or a change with no data must not skew the facts.
  const rows = await sql`
    SELECT field,
      count(*) FILTER (WHERE evaluated_at IS NULL AND status = 'applied') AS waiting,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND (result_position IS NULL OR baseline_position IS NULL) AND coalesce(note, '') NOT LIKE 'Dropped out%') AS nodata,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND baseline_position = 25 AND result_position IS NOT NULL AND result_position <= 10) AS entered,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND baseline_position = 25 AND result_position > 10) AS stilloff,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND note LIKE 'Dropped out%') AS dropped,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25) AS compared,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25 AND result_position < baseline_position - 0.5) AS up,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25 AND result_position > baseline_position + 0.5) AS down,
      avg(baseline_position - result_position) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25) AS gain,
      avg(result_clicks - baseline_clicks) FILTER (WHERE evaluated_at IS NOT NULL AND result_clicks IS NOT NULL AND baseline_clicks IS NOT NULL) AS clicks
    FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = ANY(string_to_array(${Object.keys(LABEL).join(",")}, ','))
    GROUP BY field`;
  const lines: string[] = [];
  let measured = 0;
  let waiting = 0;
  for (const r of rows) {
    const compared = Number(r.compared);
    const nodata = Number(r.nodata);
    const dropped = Number(r.dropped);
    // Not ranked before (stored as 25, the "off page one" marker), so no before position to compare with.
    const entered = Number(r.entered);
    const stillOff = Number(r.stilloff);
    waiting += Number(r.waiting);
    if (compared + nodata + dropped + entered + stillOff === 0) continue;
    measured += compared + nodata + dropped + entered + stillOff;
    const name = LABEL[String(r.field)] ?? r.field;
    if (!compared) {
      lines.push(
        `Measured result, ${name}: ${nodata + dropped + entered + stillOff} measured, ${entered ? `${entered} not on page one before and now on page one, ` : ""}${stillOff ? `${stillOff} still not on page one, ` : ""}${dropped ? `${dropped} dropped off page one, ` : ""}${nodata} without enough Google data to compare.`
      );
      continue;
    }
    const pos = Number(r.gain);
    const clk = r.clicks !== null ? Number(r.clicks) : null;
    const same = compared - Number(r.up) - Number(r.down);
    lines.push(
      `Measured result, ${name}: ${compared} compared with Google data, ${r.up} moved up, ${r.down} moved down, ${same} about the same, ` +
        `average position change ${pos >= 0 ? "up" : "down"} ${Math.abs(pos).toFixed(1)}` +
        (clk !== null ? `, average clicks change ${clk >= 0 ? "up" : "down"} ${Math.abs(clk).toFixed(1)}` : "") +
        (entered ? `, ${entered} more not on page one before and now on page one` : "") +
        (stillOff ? `, ${stillOff} more still not on page one` : "") +
        (dropped ? `, ${dropped} more dropped off page one` : "") +
        (nodata ? `, ${nodata} more without enough data` : "") +
        "."
    );
  }
  if (!measured) lines.push(`Measured results: none yet. ${waiting} changes are waiting for their four week measurement.`);
  else if (waiting) lines.push(`${waiting} more changes are waiting for their four week measurement.`);
  lines.push(...(await earlyReadings(accountId).catch(() => [])));
  return lines;
}

/**
 * Early readings for changes made at least a week ago that haven't reached their four week measurement: today's
 * position from the daily Google rank check (which reads the top 10) against the position before the change.
 * Real numbers, but early: nothing is kept or undone on them.
 */
async function earlyReadings(accountId: string): Promise<string[]> {
  const rows = await sql`
    SELECT c.field, c.baseline_position AS before, r.position AS now
    FROM insights_autopilot_changes c
    JOIN LATERAL (
      SELECT position FROM insights_rank_daily d
      WHERE d.account_id = c.account_id AND d.query = lower(c.query) ORDER BY d.checked_on DESC LIMIT 1
    ) r ON true
    WHERE c.account_id = ${accountId} AND c.status = 'applied' AND c.evaluated_at IS NULL AND c.run_id IS NOT NULL
      AND c.created_at < now() - interval '7 days' AND c.baseline_position IS NOT NULL
      AND c.field = ANY(string_to_array(${Object.keys(LABEL).join(",")}, ','))`;
  const by = new Map<string, { up: number; down: number; same: number; top10: number; notTop10: number }>();
  for (const r of rows) {
    const f = String(r.field);
    const b = by.get(f) ?? { up: 0, down: 0, same: 0, top10: 0, notTop10: 0 };
    const before = Number(r.before);
    if (r.now === null) b.notTop10++;
    else if (before === 25) b.top10++; // was off page one, now in the top 10
    else {
      const now = Number(r.now);
      if (now < before - 0.5) b.up++;
      else if (now > before + 0.5) b.down++;
      else b.same++;
    }
    by.set(f, b);
  }
  return [...by.entries()].map(
    ([f, b]) =>
      `Early reading (a week or more in, not judged yet), ${LABEL[f] ?? f}: ` +
      [
        b.up && `${b.up} moved up`,
        b.down && `${b.down} moved down`,
        b.same && `${b.same} about the same`,
        b.top10 && `${b.top10} reached the top 10 from off page one`,
        b.notTop10 && `${b.notTop10} not in the top 10 yet`,
      ]
        .filter(Boolean)
        .join(", ") +
      "."
  );
}
