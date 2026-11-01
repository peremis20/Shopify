import { ensureSchema, sql } from "../db";
import { readAuthorityPlan } from "./authority-coach";
import { readProspects } from "./backlinks";
import { readStrategy } from "./strategist";
import { controlComparison } from "./results";

/**
 * The agents' scorecard for one site: what each agent did and what came of it, from this site's own records and
 * measurements only. Numbers, never opinions: an agent whose work doesn't help shows it here.
 */
export interface AgentScore {
  agent: string;
  /** What it did, counted. */
  did: string;
  /** What came of it, measured; null while there's nothing to measure yet. */
  result: string | null;
}

const CHANGE_AGENTS: { agent: string; fields: string[]; unit: [string, string]; ranked?: false }[] = [
  { agent: "Page improver", fields: ["meta_title", "meta_description", "content", "alt", "schema"], unit: ["change", "changes"] },
  { agent: "Link builder", fields: ["internal_link"], unit: ["link", "links"] },
  { agent: "Article writer", fields: ["new_article"], unit: ["article", "articles"] },
  // Repairs and take downs aren't judged by a page's ranking.
  { agent: "Link fixer", fields: ["link_fix"], unit: ["fix", "fixes"], ranked: false },
  { agent: "Pruning agent", fields: ["prune"], unit: ["take down", "take downs"], ranked: false },
];

const PROSPECT_AGENTS: { agent: string; kinds: string[] }[] = [
  { agent: "Broken Link Agent", kinds: ["broken"] },
  { agent: "PR and Mentions Agent", kinds: ["mention", "resource", "guest", "podcast", "roundup"] },
  { agent: "Authority Coach (competitor sources)", kinds: ["competitor"] },
];

export interface FieldStats {
  field: string;
  made: number;
  suggested: number;
  compared: number;
  up: number;
  down: number;
  undone: number;
  gainSum: number;
}

const n = (k: number, unit: [string, string]) => `${k} ${k === 1 ? unit[0] : unit[1]}`;

/** Turns the counted records into the scorecard (kept apart from the database so it can be tested). */
export function scoreChanges(stats: FieldStats[]): AgentScore[] {
  return CHANGE_AGENTS.map(({ agent, fields, unit, ranked }) => {
    const s = stats.filter((x) => fields.includes(x.field));
    const sum = (k: keyof Omit<FieldStats, "field">) => s.reduce((a, x) => a + x[k], 0);
    const made = sum("made");
    const suggested = sum("suggested");
    const compared = sum("compared");
    const did = `${n(made, unit)} made on the site${suggested ? `, ${suggested} suggested` : ""}`;
    if (ranked === false) return { agent, did, result: made ? "Not measured by ranking." : null };
    if (!compared) return { agent, did, result: made ? "Nothing measured yet (four weeks after each change)." : null };
    const avg = sum("gainSum") / compared;
    return {
      agent,
      did,
      result:
        `${compared} measured: ${sum("up")} moved up, ${sum("down")} moved down, average ${avg >= 0 ? "up" : "down"} ${Math.abs(avg).toFixed(1)} places` +
        (sum("undone") ? `, ${sum("undone")} undone for falling` : "") +
        ".",
    };
  });
}

export function scoreProspects(prospects: { kind: string; status: string }[]): AgentScore[] {
  return PROSPECT_AGENTS.map(({ agent, kinds }) => {
    const mine = prospects.filter((p) => kinds.includes(p.kind));
    const contacted = mine.filter((p) => p.status === "contacted" || p.status === "won").length;
    const won = mine.filter((p) => p.status === "won").length;
    return {
      agent,
      did: `${mine.length} backlink ${mine.length === 1 ? "site" : "sites"} found`,
      result: contacted ? `${contacted} emailed, ${won} ${won === 1 ? "link" : "links"} won.` : mine.length ? "None emailed yet." : null,
    };
  });
}

export async function readScorecard(accountId: string): Promise<AgentScore[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT field,
      count(*) FILTER (WHERE status IN ('applied', 'kept', 'reverted')) AS made,
      count(*) FILTER (WHERE status = 'suggested') AS suggested,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25) AS compared,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25 AND result_position < baseline_position - 0.5) AS up,
      count(*) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25 AND result_position > baseline_position + 0.5) AS down,
      count(*) FILTER (WHERE note LIKE 'Ranking dropped%' OR note LIKE 'Dropped out:%') AS undone,
      coalesce(sum(baseline_position - result_position) FILTER (WHERE evaluated_at IS NOT NULL AND result_position IS NOT NULL AND baseline_position IS NOT NULL AND baseline_position <> 25), 0) AS gain
    FROM insights_autopilot_changes WHERE account_id = ${accountId} GROUP BY field`;
  const stats: FieldStats[] = rows.map((r) => ({
    field: String(r.field),
    made: Number(r.made),
    suggested: Number(r.suggested),
    compared: Number(r.compared),
    up: Number(r.up),
    down: Number(r.down),
    undone: Number(r.undone),
    gainSum: Number(r.gain),
  }));
  const out = scoreChanges(stats);
  const list = await readProspects(accountId).catch(() => null);
  out.push(...scoreProspects(list?.prospects ?? []));
  const [{ held }] = await sql`SELECT count(*) AS held FROM insights_autopilot_controls WHERE account_id = ${accountId}`.catch(() => [{ held: 0 }]);
  if (Number(held)) {
    out.push({
      agent: "Control groups",
      did: `${held} similar ${Number(held) === 1 ? "page" : "pages"} left untouched beside a change`,
      result: (await controlComparison(accountId).catch(() => null)) ?? "Nothing measured yet (four weeks after each change).",
    });
  }
  const strategy = await readStrategy(accountId).catch(() => null);
  if (strategy) {
    const kept = strategy.moves.filter((m) => m.kept).length;
    out.push({ agent: "Strategist", did: `${strategy.moves.length} moves planned (${strategy.at.slice(0, 10)})`, result: `${kept} kept after the checks, ${strategy.moves.length - kept} dropped.` });
  }
  const plan = await readAuthorityPlan(accountId).catch(() => null);
  if (plan) {
    const kept = plan.moves.filter((m) => m.kept).length;
    out.push({ agent: "Authority Coach (plan)", did: `${plan.moves.length} moves planned (${plan.at.slice(0, 10)})`, result: `${kept} kept after the checks, ${plan.moves.length - kept} dropped.` });
  }
  const [insp] = await sql`SELECT value FROM insights_settings WHERE key = ${`inspect:${accountId}`}`.catch(() => [] as { value: string | null }[]);
  if (insp?.value) {
    const problems = (JSON.parse(insp.value) as { problems: { who: string }[] }).problems ?? [];
    const repaired = problems.filter((p) => p.who === "repaired").length;
    out.push({ agent: "Inspector", did: `${problems.length} ${problems.length === 1 ? "problem" : "problems"} found in the last check`, result: `${repaired} repaired by agents, ${problems.length - repaired} need a person or are being watched.` });
  }
  return out.filter((s) => s.result !== null || !/^0 /.test(s.did));
}
