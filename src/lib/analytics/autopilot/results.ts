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
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND baseline_position = 25 AND result_position IS NOT NULL) AS entered,
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
    waiting += Number(r.waiting);
    if (compared + nodata + dropped + entered === 0) continue;
    measured += compared + nodata + dropped + entered;
    const name = LABEL[String(r.field)] ?? r.field;
    if (!compared) {
      lines.push(
        `Measured result, ${name}: ${nodata + dropped + entered} measured, ${entered ? `${entered} not ranked before and now found in the results, ` : ""}${dropped ? `${dropped} dropped out of the results checked, ` : ""}${nodata} without enough Google data to compare.`
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
        (entered ? `, ${entered} more not ranked before and now found in the results` : "") +
        (dropped ? `, ${dropped} more dropped out of the results checked` : "") +
        (nodata ? `, ${nodata} more without enough data` : "") +
        "."
    );
  }
  if (!measured) lines.push(`Measured results: none yet. ${waiting} changes are waiting for their four week measurement.`);
  else if (waiting) lines.push(`${waiting} more changes are waiting for their four week measurement.`);
  return lines;
}
