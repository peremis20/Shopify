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

/** Which way one change went between two rank checks (null: not in the top 10 that day). */
export function earlyBucket(before: number | null, now: number | null): "up" | "down" | "same" | "reached" | "dropped" | "still" {
  if (before === null && now === null) return "still";
  if (before === null) return "reached";
  if (now === null) return "dropped";
  return now < before ? "up" : now > before ? "down" : "same";
}

/**
 * Early readings for changes made at least a week ago that haven't reached their four week measurement. Both
 * numbers come from the same daily Google rank check (which reads the top 10): the last check on or before the
 * day of the change, and the latest check a week or more after it. Real numbers, but early: nothing is kept or
 * undone on them.
 */
async function earlyReadings(accountId: string): Promise<string[]> {
  const rows = await sql`
    SELECT c.field, b.position AS before, a.position AS now
    FROM insights_autopilot_changes c
    JOIN LATERAL (
      SELECT position FROM insights_rank_daily d
      WHERE d.account_id = c.account_id AND d.query = lower(c.query) AND d.checked_on < c.created_at::date AND d.checked_on >= c.created_at::date - 14
      ORDER BY d.checked_on DESC LIMIT 1
    ) b ON true
    JOIN LATERAL (
      SELECT position FROM insights_rank_daily d
      WHERE d.account_id = c.account_id AND d.query = lower(c.query) AND d.checked_on >= (c.created_at + interval '7 days')::date
      ORDER BY d.checked_on DESC LIMIT 1
    ) a ON true
    WHERE c.account_id = ${accountId} AND c.status = 'applied' AND c.evaluated_at IS NULL AND c.run_id IS NOT NULL
      AND c.created_at < now() - interval '7 days'
      AND c.field = ANY(string_to_array(${Object.keys(LABEL).join(",")}, ','))`;
  const by = new Map<string, { up: number; down: number; same: number; reached: number; dropped: number; still: number }>();
  for (const r of rows) {
    const f = String(r.field);
    const b = by.get(f) ?? { up: 0, down: 0, same: 0, reached: 0, dropped: 0, still: 0 };
    b[earlyBucket(r.before === null ? null : Number(r.before), r.now === null ? null : Number(r.now))]++;
    by.set(f, b);
  }
  return [...by.entries()].map(
    ([f, b]) =>
      `Early reading from the daily rank check (a week or more in, not judged yet), ${LABEL[f] ?? f}: ` +
      [
        b.up && `${b.up} moved up`,
        b.down && `${b.down} moved down`,
        b.same && `${b.same} same position`,
        b.reached && `${b.reached} reached the top 10`,
        b.dropped && `${b.dropped} dropped out of the top 10`,
        b.still && `${b.still} not in the top 10 before or now`,
      ]
        .filter(Boolean)
        .join(", ") +
      "."
  );
}
