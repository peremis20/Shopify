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
  const rows = await sql`
    SELECT field,
      count(*) FILTER (WHERE evaluated_at IS NULL AND status = 'applied') AS waiting,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND status = 'kept') AS kept,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND status <> 'kept') AS undone,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL) AS compared,
      avg(baseline_position - result_position) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL) AS gain,
      avg(result_clicks - baseline_clicks) FILTER (WHERE evaluated_at IS NOT NULL AND result_clicks IS NOT NULL) AS clicks
    FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = ANY(string_to_array(${Object.keys(LABEL).join(",")}, ','))
    GROUP BY field`;
  const lines: string[] = [];
  let measured = 0;
  let waiting = 0;
  for (const r of rows) {
    const kept = Number(r.kept);
    const undone = Number(r.undone);
    const compared = Number(r.compared);
    waiting += Number(r.waiting);
    if (kept + undone === 0) continue;
    measured += kept + undone;
    const pos = compared && r.gain !== null ? Number(r.gain) : null;
    const clk = r.clicks !== null ? Number(r.clicks) : null;
    lines.push(
      `Measured result, ${LABEL[String(r.field)] ?? r.field}: ${kept} kept, ${undone} undone` +
        (pos !== null ? `, average position change ${pos >= 0 ? "up" : "down"} ${Math.abs(pos).toFixed(1)}` : "") +
        (clk !== null ? `, average clicks change ${clk >= 0 ? "+" : ""}${clk.toFixed(1)}` : "") +
        ` (${compared} compared with Google data).`
    );
  }
  if (!measured) lines.push(`Measured results: none yet. ${waiting} changes are waiting for their four week measurement.`);
  else if (waiting) lines.push(`${waiting} more changes are waiting for their four week measurement.`);
  return lines;
}
