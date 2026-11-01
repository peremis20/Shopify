import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { queryPageRows90d } from "../seo-tools";
import { readAuthorityHistory, type Rival } from "./authority";
import { NOT_PROSPECTS, readProspects, upsertProspects, type Prospect } from "./backlinks";
import { clientListKnown, otherClient } from "./clients";
import { fetchSerp } from "./serp";
import { aiProvider, readPlatformSettings } from "./settings";
import { isBig } from "./site-keywords";
import { readStrategy } from "./strategist";
import { challengeStrategy, planAuthority, type AuthorityMove } from "./writer";

/**
 * The Authority Coach. Once a week per site it:
 * 1. Learns from what works for competitors: pages that mention the sites
 *    beating this one on Google, but not this site, are proven link sources
 *    in the niche. They become backlink prospects.
 * 2. Plans up to five moves to raise the site's authority from everything the
 *    other agents know (site strength and its trend, backlinks found, emailed
 *    and won, broken links found, the pages that already earn clicks, the
 *    Strategist's weekly plan). A second AI challenges every move; only moves
 *    the data backs are kept. The Strategist reads this plan too.
 */

export interface AuthorityPlan {
  at: string;
  assessment: string;
  moves: (AuthorityMove & { kept: boolean; challenge: string })[];
  /** Competitors studied this week and how many link sources they gave. */
  studied: { domain: string; found: number }[];
}

const KEY = (accountId: string) => `authority_plan:${accountId}`;
const COMPETITORS = 3;

export async function readAuthorityPlan(accountId: string): Promise<AuthorityPlan | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as AuthorityPlan) : null;
}

/** Accounts with the autopilot on whose weekly authority plan is due (a failed run also waits a week). */
export async function accountsDueForAuthorityCoach(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'authority_plan:' || a.account_id
    LEFT JOIN insights_settings f ON f.key = 'authority_tried:' || a.account_id
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
      AND (f.updated_at IS NULL OR f.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export async function markAuthorityTried(accountId: string, note: string): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`authority_tried:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), note })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
}

/** The sites beating this one on its searches, from the last "sites that keep beating you" check. */
async function latestRivals(accountId: string): Promise<Rival[]> {
  const [row] = await sql`SELECT data FROM insights_report_cache WHERE cache_key = ${`rivals:${accountId}`}`.catch(() => [] as { data: string | null }[]);
  return row?.data ? (JSON.parse(row.data) as Rival[]) : [];
}

export async function runAuthorityCoach(accountId: string, conn: Connection | null, ourDomain: string): Promise<AuthorityPlan | null> {
  const platform = await readPlatformSettings();
  const ai = aiProvider(platform);
  if (!ai) {
    await markAuthorityTried(accountId, "no AI key");
    return null;
  }
  const ours = ourDomain.replace(/^www\./, "");

  // 1. What works for competitors: who mentions them but not us.
  const studied: AuthorityPlan["studied"] = [];
  const rivals = (await latestRivals(accountId)).filter((r) => !isBig(r.domain)).slice(0, COMPETITORS);
  if (platform.serperKey && rivals.length && (await clientListKnown())) {
    const isOther = await otherClient(ours);
    const found: Prospect[] = [];
    for (const r of rivals) {
      if (isOther(r.domain)) continue;
      const serp = await fetchSerp(platform.serperKey, `"${r.domain}" -site:${r.domain} -site:${ours}`).catch(() => null);
      let n = 0;
      for (const x of serp?.organic ?? []) {
        const d = x.domain.toLowerCase().replace(/^www\./, "");
        if (d === ours || d.endsWith(`.${ours}`) || d === r.domain || NOT_PROSPECTS.test(d) || isBig(d) || isOther(d)) continue;
        found.push({
          url: x.link,
          domain: d,
          title: x.title,
          snippet: x.snippet ?? "",
          kind: "competitor",
          topic: r.searches[0] ?? r.domain,
          authority: null,
          status: "new",
          foundAt: new Date().toISOString(),
          rival: r.domain,
        });
        n++;
      }
      studied.push({ domain: r.domain, found: n });
    }
    if (found.length) await upsertProspects(accountId, found);
  }

  // 2. Everything the agents know, as facts the planner (and its critic) can check against.
  const lines: string[] = [];
  const hist = await readAuthorityHistory(accountId).catch(() => []);
  lines.push(
    hist.length
      ? `Site strength (Open PageRank, 0 to 10): ${hist[hist.length - 1].score}${hist.length > 1 ? `, was ${hist[0].score} on ${hist[0].day}` : ""}.`
      : "Site strength: not measured yet."
  );
  if (rivals.length) lines.push("Sites beating it on its searches: " + rivals.map((r) => `${r.domain} (strength ${r.authority ?? "unknown"}, ahead on ${r.beats} searches)`).join("; "));
  if (studied.length) lines.push("Pages mentioning those competitors but not this site, found this week: " + studied.map((s) => `${s.domain}: ${s.found}`).join("; "));
  const list = await readProspects(accountId).catch(() => null);
  const ps = list?.prospects ?? [];
  const by = (k: string) => ps.filter((p) => p.kind === k);
  lines.push(
    `Backlink list: ${ps.length} sites. Not contacted yet: ${ps.filter((p) => p.status === "new").length}. Emailed: ${ps.filter((p) => p.status === "contacted").length}. Links won: ${ps.filter((p) => p.status === "won").length}. Skipped: ${ps.filter((p) => p.status === "skip").length}.`
  );
  lines.push(
    `By kind: mentions ${by("mention").length}, resource pages ${by("resource").length}, guest articles ${by("guest").length}, podcasts ${by("podcast").length}, expert roundups ${by("roundup").length}, broken links ${by("broken").length}, competitor sources ${by("competitor").length}.`
  );
  const strongest = ps.filter((p) => p.status === "new").sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0)).slice(0, 5);
  if (strongest.length) lines.push("Strongest sites not contacted yet: " + strongest.map((p) => `${p.domain} (${p.kind}, strength ${p.authority ?? "unknown"})`).join("; "));
  if (conn?.gscSiteUrl) {
    const rows = await queryPageRows90d(conn).catch(() => []);
    const byPage = new Map<string, number>();
    for (const r of rows) byPage.set(r.page, (byPage.get(r.page) ?? 0) + r.clicks);
    const top = [...byPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) lines.push("Pages that already earn the most Google clicks (90 days), the best ones to offer: " + top.map(([p, c]) => `${p} (${c})`).join("; "));
  }
  const strategy = await readStrategy(accountId).catch(() => null);
  if (strategy) lines.push(`The Strategist's plan this week: ${strategy.assessment} Moves: ${strategy.moves.filter((m) => m.kept).map((m) => m.action).join(" ")}`);
  const facts = lines.join("\n");

  // 3. Plan, then a second AI challenges each move.
  const plan = await planAuthority(ai, facts);
  const moves = plan.moves.slice(0, 5);
  const verdict = await challengeStrategy(ai, facts, { moves }).catch(() => ({ keep: moves.map(() => true), notes: moves.map(() => "Not challenged: the reviewing AI was unavailable.") }));
  const report: AuthorityPlan = {
    at: new Date().toISOString(),
    assessment: plan.assessment,
    moves: moves.map((m, i) => ({ ...m, kept: verdict.keep[i], challenge: verdict.notes[i] })),
    studied,
  };
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(report)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return report;
}
