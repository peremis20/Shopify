import { ensureSchema, sql } from "../db";
import { keywordIdeas, keywordVolumes } from "../keywords";
import { otherClient } from "./clients";
import { isJunkKeyword } from "./keyword-guard";
import { readPlatformSettings } from "./settings";
import { cachedSerp, fetchSerp } from "./serp";
import { faithAllowed, isBig, readSiteKeywords, topicWords } from "./site-keywords";
import { readTargets } from "./targets";
import { report } from "./status";
import { nullUnlessLimit, SpendingLimitReached } from "./usage";

/**
 * The Idea finder: once a week per site, new searches worth a page, found three ways that don't need the site to rank
 * yet (Search Console alone can't, for a small site):
 * - Google's related searches for the site's topics,
 * - Google's "People also ask" questions for them,
 * - Keyword Planner ideas from the pages that rank on page one (the competitor gap).
 * Only public facts are used, other customers' sites are never studied, and every idea gets real monthly searches
 * from Keyword Planner before it counts. The Strategist (and its critic) decides which ones to go after.
 */
export interface SearchIdea {
  keyword: string;
  monthlySearches: number | null;
  source: "related" | "question" | "competitor";
  /** The topic, or the competitor page, it came from. */
  from: string;
}

export interface IdeaReport {
  at: string;
  ideas: SearchIdea[];
  /** Questions people ask that have too few searches for a page of their own: good FAQ material. */
  questions: string[];
  note: string;
}

const TARGETING = { geo: "2840", language: "1000" };
const SEEDS = 5;
const COMPETITOR_PAGES = 3;
const KEEP = 25;
const MIN_SEARCHES = 20;
const key = (accountId: string) => `ideas:${accountId}`;

export async function readIdeas(accountId: string): Promise<IdeaReport | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key(accountId)}`;
  try {
    return row ? (JSON.parse(String(row.value)) as IdeaReport) : null;
  } catch {
    return null;
  }
}

/** Enabled sites whose ideas are a week old (or never found), one try a week even when it finds nothing. */
export async function accountsDueForIdeas(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'ideas:' || a.account_id
    LEFT JOIN insights_settings f ON f.key = 'ideas_tried:' || a.account_id
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
      -- A failed try waits (6 hours, or a week when it was the site's monthly limit), so one site can't hold up the rest.
      AND (f.updated_at IS NULL OR f.updated_at < now() - CASE WHEN f.value LIKE 'limit:%' THEN interval '7 days' ELSE interval '6 hours' END)
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** A try that failed: remembered so it waits, and shown on the status board (a spending limit isn't a fault). */
export async function markIdeasTried(accountId: string, err: unknown): Promise<void> {
  const limit = err instanceof SpendingLimitReached;
  const msg = (err as Error)?.message ?? String(err);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`ideas_tried:${accountId}`}, ${`${limit ? "limit" : "error"}: ${msg}`.slice(0, 300)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  if (!limit) void report("idea-finder", false, msg);
}

async function save(accountId: string, report: IdeaReport): Promise<IdeaReport> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key(accountId)}, ${JSON.stringify(report)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return report;
}

/** A question or related search as a plain search phrase. */
export const asSearch = (s: string) =>
  s
    .toLowerCase()
    .replace(/[?!.]+$/g, "")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export async function runIdeaFinder(accountId: string, ourDomain: string): Promise<IdeaReport> {
  const platform = await readPlatformSettings();
  const nothing = (note: string) => save(accountId, { at: new Date().toISOString(), ideas: [], questions: [], note });
  if (!platform.serperKey) return nothing("No search results key, so Google page one can't be read.");

  const [targets, kws, faith] = await Promise.all([
    readTargets(accountId).catch(() => []),
    readSiteKeywords(accountId).catch(() => []),
    faithAllowed(accountId).catch(() => false),
  ]);
  // The site's own topics, biggest first: what it already aims for.
  const seeds = [
    ...targets.map((t) => ({ k: t.keyword, n: t.monthlySearches })),
    ...kws.filter((k) => k.role !== "support").map((k) => ({ k: k.keyword, n: k.monthlySearches })),
  ]
    .sort((a, b) => b.n - a.n)
    .map((s) => s.k)
    .filter((k, i, all) => all.indexOf(k) === i)
    .slice(0, SEEDS);
  if (!seeds.length) return nothing("No topics yet: add searches with Rank for this, or connect Search Console.");

  const known = new Set([...targets.map((t) => t.keyword), ...kws.map((k) => k.keyword)].map(asSearch));
  const siteWords = new Set(seeds.flatMap((s) => [...topicWords(s)]));
  // On topic for this site: shares a real word with one of its topics.
  const onTopic = (k: string) => [...topicWords(k)].some((w) => siteWords.has(w));
  const usable = (k: string) => k.split(" ").length >= 2 && k.length <= 80 && !known.has(k) && onTopic(k) && !isJunkKeyword(k, { faith });

  const isOtherClient = await otherClient(ourDomain);
  const ours = ourDomain.replace(/^www\./, "");
  const found = new Map<string, SearchIdea>();
  const questions: string[] = [];
  const competitorPages: { url: string; from: string }[] = [];

  for (const seed of seeds) {
    const serp = (await cachedSerp(seed).catch(() => null)) ?? (await fetchSerp(platform.serperKey, seed).catch(nullUnlessLimit));
    if (!serp) continue;
    for (const r of serp.related) {
      const k = asSearch(r);
      if (usable(k) && !found.has(k)) found.set(k, { keyword: k, monthlySearches: null, source: "related", from: seed });
    }
    for (const q of serp.questions) {
      const k = asSearch(q);
      if (usable(k) && !found.has(k)) found.set(k, { keyword: k, monthlySearches: null, source: "question", from: seed });
      if (onTopic(k) && !isJunkKeyword(k, { faith }) && !questions.includes(q)) questions.push(q);
    }
    // The best ranking page that isn't ours, a big publisher or another customer.
    const rival = serp.organic.slice(0, 5).find((o) => {
      const d = o.domain.replace(/^www\./, "");
      return d !== ours && !d.endsWith(`.${ours}`) && !isBig(o.domain) && !isOtherClient(o.domain);
    });
    // One page per rival, so the same site doesn't use up every competitor check.
    if (rival && competitorPages.length < COMPETITOR_PAGES && !competitorPages.some((c) => c.from === rival.domain))
      competitorPages.push({ url: rival.link, from: rival.domain });
  }

  // Real monthly searches for every related search and question, in one call.
  let plannerOk = true;
  const volumes = found.size ? await keywordVolumes({ ...TARGETING, keywords: [...found.keys()] }).catch(() => ((plannerOk = false), [])) : [];
  for (const v of volumes) {
    const idea = found.get(v.keyword.toLowerCase());
    if (idea) idea.monthlySearches = v.avgMonthlySearches ?? 0;
  }
  // The competitor gap: what Keyword Planner says those pages are about, that this site doesn't cover yet.
  const label = (d: string) => d.replace(/^www\./, "").split(".")[0];
  for (const page of plannerOk ? competitorPages : []) {
    const ideas = await keywordIdeas({ ...TARGETING, keywords: [], url: page.url }).catch(() => []);
    // A search for a brand (theirs or ours) is someone looking for that site, not a topic to write about.
    const brands = [label(page.from), label(ourDomain)].filter((b) => b.length > 3);
    for (const i of ideas.slice(0, 40)) {
      const k = asSearch(i.keyword);
      if (brands.some((b) => k.replace(/\s+/g, "").includes(b))) continue;
      if (usable(k) && !found.has(k)) found.set(k, { keyword: k, monthlySearches: i.avgMonthlySearches ?? 0, source: "competitor", from: page.from });
    }
  }

  const ideas = [...found.values()]
    // Without Keyword Planner nothing can be measured, so nothing counts as an idea (never a guessed volume).
    .filter((i) => plannerOk && (i.monthlySearches ?? 0) >= MIN_SEARCHES)
    .sort((a, b) => (b.monthlySearches ?? -1) - (a.monthlySearches ?? -1))
    .slice(0, KEEP);
  const kept = new Set(ideas.map((i) => i.keyword));
  const faq = questions.filter((q) => !kept.has(asSearch(q))).slice(0, 10);
  const by = (s: SearchIdea["source"]) => ideas.filter((i) => i.source === s).length;
  const note = ideas.length
    ? `${ideas.length} new searches found (${by("related")} related, ${by("question")} questions, ${by("competitor")} from competitor pages)${plannerOk ? "" : "; monthly searches unknown because Keyword Planner isn't working"}.`
    : plannerOk
      ? `No new searches with enough monthly searches this week (${seeds.length} topics checked).`
      : "Keyword Planner isn't working, so no search could be measured this week.";
  if (!plannerOk) void report("idea-finder", false, "Keyword Planner couldn't measure the searches found.");
  else void report("idea-finder", true);
  return save(accountId, { at: new Date().toISOString(), ideas, questions: faq, note });
}
