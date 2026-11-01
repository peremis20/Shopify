import { readAuthorityPlan } from "./authority-coach";
import { measuredResults } from "./results";
import { readScorecard } from "./scorecard";
import { rankingTurbulence } from "./google-updates";
import { readReviewer, reviewList } from "./expert-review";
import { pageValues } from "./signals";
import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { findOpportunities, gscClicks28d } from "../seo-tools";
import { readAuthorityHistory } from "./authority";
import { readProspects } from "./backlinks";
import { inspect } from "./inspector";
import { isJunkKeyword } from "./keyword-guard";
import { aiProvider, readPlatformSettings, type AiProvider } from "./settings";
import { faithAllowed, readSiteKeywords } from "./site-keywords";
import { addTarget, readTargets, saveTarget } from "./targets";
import { rankWatch } from "./tracking";
import { backedByFacts, challengeStrategy, planStrategy, type StrategyMove } from "./writer";

/**
 * The Strategist: once a week it reads everything the other agents learned
 * (rankings, near misses, difficulty, results of past changes, site strength,
 * backlinks, the Inspector's findings) and plans the week toward 20,000
 * visitors a month. A second AI, from another provider when there is one,
 * challenges each move; only moves that survive are acted on. Search moves
 * become targets the autopilot works on first. Everything is saved, including
 * the moves that were challenged and dropped, so the owner sees the debate.
 */

export interface StrategyReport {
  at: string;
  assessment: string;
  moves: (StrategyMove & { kept: boolean; challenge: string; done: string | null })[];
  /** Google visitors in the last 28 days, when Search Console is connected. */
  visitors: number | null;
  /** Sales from Google visitors in the last 28 days (Google Analytics ecommerce), when tracked. */
  revenue?: number | null;
  goal: number;
  /** The exact data the plan was made from, so every kept or dropped move can be checked afterwards. */
  facts?: string;
  /** False when the reviewing AI was unavailable: the moves are shown but not acted on. */
  checked?: boolean;
}

const GOAL = 20_000;
const WEEK = 7 * 24 * 3600 * 1000;
const KEY = (accountId: string) => `strategy:${accountId}`;
/** New targets the Strategist may add in one week. */
const MAX_NEW_TARGETS = 3;

export async function readStrategy(accountId: string): Promise<StrategyReport | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as StrategyReport) : null;
}

export const strategyDue = (r: StrategyReport | null) => !r || Date.now() - Date.parse(r.at) > WEEK;

/** Everything the agents know, as plain facts the strategist (and its critic) can check against. */
async function gatherFacts(accountId: string, conn: Connection | null, ourDomain: string): Promise<{ facts: string; known: Set<string>; visitors: number | null; revenue: number | null }> {
  const lines: string[] = [];
  const known = new Set<string>();
  let visitors: number | null = null;

  const near = conn?.gscSiteUrl ? await findOpportunities(conn, "28d").catch(() => []) : [];
  if (conn?.gscSiteUrl) visitors = await gscClicks28d(conn).catch(() => null);
  const top = [...near].sort((a, b) => b.impressions - a.impressions).slice(0, 15);
  if (top.length) {
    lines.push("Searches where the site is on Google positions 4 to 20 (last 28 days): " + top.map((o) => `"${o.query}" #${o.position.toFixed(0)} (${o.impressions} impressions, ${o.clicks} clicks)`).join("; "));
    top.forEach((o) => known.add(o.query.toLowerCase()));
  }

  const ranks = await rankWatch(accountId).catch(() => []);
  const onPage1 = ranks.filter((r) => r.position !== null && r.position <= 10);
  lines.push(`Daily rank check: ${ranks.length} searches tracked, ${onPage1.length} on page 1.`);
  const moved = ranks.filter((r) => r.previous !== null && r.position !== null && r.previous !== r.position).slice(0, 8);
  if (moved.length) lines.push("Recent moves: " + moved.map((r) => `"${r.query}" #${r.previous} to #${r.position}`).join("; "));
  ranks.forEach((r) => known.add(r.query.toLowerCase()));

  const [targets, kws] = await Promise.all([readTargets(accountId).catch(() => []), readSiteKeywords(accountId).catch(() => [])]);
  if (targets.length) {
    lines.push("Searches already targeted: " + targets.slice(0, 15).map((t) => `"${t.keyword}" (${t.monthlySearches}/mo${t.difficulty !== undefined ? `, difficulty ${t.difficulty}` : ""}${t.page ? "" : ", no page yet"})`).join("; "));
    targets.forEach((t) => known.add(t.keyword));
  }
  const ideas = kws.filter((k) => k.role !== "support" && !targets.some((t) => t.keyword === k.keyword)).slice(0, 15);
  if (ideas.length) {
    lines.push("Keyword ideas not targeted yet: " + ideas.map((k) => `"${k.keyword}" (${k.monthlySearches}/mo${k.difficulty !== undefined ? `, difficulty ${k.difficulty}` : ""}${k.winnable === false ? ", page 1 crowded" : ""})`).join("; "));
    ideas.forEach((k) => known.add(k.keyword));
  }

  const changes = await sql`
    SELECT field, status, baseline_position, result_position FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND created_at > now() - interval '30 days'`;
  const measured = changes.filter((c) => c.baseline_position && c.result_position);
  const up = measured.filter((c) => Number(c.result_position) < Number(c.baseline_position) - 0.5).length;
  const down = measured.filter((c) => Number(c.result_position) > Number(c.baseline_position) + 0.5).length;
  const articles = changes.filter((c) => c.field === "new_article").length;
  lines.push(`Last 30 days the agents made ${changes.length} changes (${articles} new articles); of ${measured.length} measured, ${up} moved up and ${down} moved down; ${changes.filter((c) => c.status === "reverted").length} were undone.`);

  const hist = await readAuthorityHistory(accountId).catch(() => []);
  lines.push(hist.length ? `Site strength (Open PageRank, 0 to 10): ${hist[hist.length - 1].score}.` : "Site strength: not measured yet.");
  const prospects = await readProspects(accountId).catch(() => null);
  if (prospects) {
    const ps = prospects.prospects;
    lines.push(`Backlinks: ${ps.filter((p) => p.status === "won").length} won, ${ps.filter((p) => p.status === "contacted").length} emailed, ${ps.filter((p) => p.status === "new").length} not contacted yet.`);
  }
  const problems = await inspect(accountId, conn, { repair: false, ourDomain }).catch(() => []);
  if (problems.length) lines.push("Inspector found: " + problems.map((p) => p.text).join(" "));
  // What the agents' own changes did on this site, measured four weeks after each one: the data to learn from.
  lines.push(...(await measuredResults(accountId).catch(() => [])));
  // Expert review: a trust signal Google weighs heavily on health and money topics.
  const items = await reviewList(accountId).catch(() => []);
  if (items.length) {
    const reviewer = await readReviewer(accountId).catch(() => null);
    lines.push(`Expert review: ${items.filter((i) => i.reviewedAt).length} of ${items.length} app written articles reviewed${reviewer ? "" : " (no reviewer added yet)"}.`);
  }
  const swing = await rankingTurbulence().catch(() => null);
  if (swing) lines.push(`Google update: ${swing}`);
  // Each agent's record on this site, counted: which agents' work is paying off.
  for (const s of await readScorecard(accountId).catch(() => [])) {
    if (s.agent !== "Strategist") lines.push(`Agent record, ${s.agent}: ${s.did}.${s.result ? ` ${s.result}` : ""}`);
  }
  // The Authority Coach shares what it measured (not its plan): link sources found from competitors this week.
  const authority = await readAuthorityPlan(accountId).catch(() => null);
  if (authority?.studied.length) {
    lines.push(`Link sources found from competitors (Authority Coach, ${authority.at.slice(0, 10)}): ` + authority.studied.map((s) => `${s.domain}: ${s.found}`).join("; ") + ".");
  }
  lines.push(visitors !== null ? `Visitors from Google search, last 28 days: ${visitors}. Goal: ${GOAL} a month.` : `Google visitors: unknown (Search Console not connected). Goal: ${GOAL} a month.`);
  // Revenue matters as much as visitors: fewer visitors who buy beat many who don't.
  let revenue: number | null = null;
  if (conn?.gaPropertyId) {
    const values = await pageValues(conn).catch(() => null);
    if (values) {
      const pages = [...values.entries()].filter(([, v]) => v.revenue > 0).sort((a, b) => b[1].revenue - a[1].revenue);
      revenue = pages.reduce((a, [, v]) => a + v.revenue, 0);
      lines.push(
        revenue > 0
          ? `Sales from Google visitors, last 28 days: ${Math.round(revenue)}. Pages that sell most: ${pages.slice(0, 5).map(([p, v]) => `${p} (${Math.round(v.revenue)})`).join("; ")}.`
          : "Sales from Google visitors: none tracked in the last 28 days (Google Analytics may not record purchases yet)."
      );
    }
  }

  return { facts: lines.join("\n"), known, visitors, revenue };
}

/** Plans the week, has it challenged, acts on what survives. */
export async function runStrategist(accountId: string, conn: Connection | null, ourDomain: string): Promise<StrategyReport | null> {
  const platform = await readPlatformSettings();
  const ai: AiProvider | null = aiProvider(platform);
  if (!ai) return null;
  const { facts, known, visitors, revenue } = await gatherFacts(accountId, conn, ourDomain);
  const plan = await planStrategy(ai, facts);
  const moves = plan.moves.slice(0, 5);
  // Unchallenged moves are shown, but nothing is acted on until a second AI has checked it.
  let checked = true;
  const verdict = await challengeStrategy(ai, facts, { ...plan, moves }).catch(() => {
    checked = false;
    return { keep: moves.map(() => true), notes: moves.map(() => "Not challenged: the reviewing AI was unavailable, so nothing was acted on.") };
  });

  const faith = await faithAllowed(accountId);
  let added = 0;
  const out: StrategyReport["moves"] = [];
  for (const [i, m] of moves.entries()) {
    const k = m.keyword?.trim().toLowerCase() ?? null;
    let kept = verdict.keep[i];
    let challenge = verdict.notes[i];
    // Data, not opinion: a move whose evidence isn't in this week's facts is dropped, whatever the critic said.
    if (kept && !backedByFacts(m.evidence, facts)) {
      kept = false;
      challenge = "Dropped: what it rests on isn't in this week's data.";
    }
    // The agents only act on searches that really appear in the data, never invented ones.
    if (kept && k && (m.kind === "target" || m.kind === "cluster") && (!known.has(k) || isJunkKeyword(k, { faith }))) {
      kept = false;
      challenge = `Dropped: "${k}" isn't in the site's data or isn't on topic.`;
    }
    let done: string | null = null;
    if (checked && kept && k && (m.kind === "target" || m.kind === "cluster") && added < MAX_NEW_TARGETS && platform.serperKey) {
      const already = (await readTargets(accountId).catch(() => [])).some((t) => t.keyword === k);
      if (!already) {
        const result = await addTarget(accountId, k, { serperKey: platform.serperKey, ourDomain }, m.kind === "cluster").catch((e) => {
          console.error(`strategist could not add target "${k}": ${(e as Error).message}`);
          return null;
        });
        if (result) {
          added++;
          // A cluster: the topic itself becomes the pillar, and the long tail searches added with it are its articles.
          if (m.kind === "cluster" && result.added.length > 0) {
            const all = await readTargets(accountId).catch(() => []);
            for (const t of all) {
              if (t.keyword === k) await saveTarget(accountId, { ...t, cluster: k, pillar: true });
              else if (result.added.includes(t.keyword)) await saveTarget(accountId, { ...t, cluster: k });
            }
          }
          done = m.kind === "cluster" ? `Added as a target, with its best long tail searches, so the autopilot builds articles around it.` : "Added as a target: the autopilot works on it first.";
        } else {
          done = "Couldn't be added as a target this time; it will be tried again next week.";
        }
      }
    }
    if (kept && m.kind === "asset" && !done) done = "An idea for you: the agents can't make this one on their own yet.";
    out.push({ ...m, keyword: k, kept, challenge, done });
  }
  const report: StrategyReport = { at: new Date().toISOString(), assessment: plan.assessment, moves: out, visitors, revenue, goal: GOAL, facts, checked };
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(report)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return report;
}

/** Accounts with the autopilot on whose weekly plan is due, oldest first. */
export async function accountsDueForStrategy(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'strategy:' || a.account_id
    LEFT JOIN insights_settings f ON f.key = 'strategy_tried:' || a.account_id
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
      -- A site whose plan failed waits 6 hours before trying again, so it can't hold up the others.
      AND (f.updated_at IS NULL OR f.updated_at < now() - interval '6 hours')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** Records a planning attempt (and its error), so a failing site is retried later instead of blocking the queue. */
export async function markStrategyTried(accountId: string, error: string | null): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`strategy_tried:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), error })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
}
