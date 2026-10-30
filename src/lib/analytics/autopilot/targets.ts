import { ensureSchema, sql } from "../db";
import { keywordVolumes } from "../keywords";
import { isPostUrl, sitePages } from "../site-crawl";
import { addKeywords, createList, getLists } from "../seo-tools";
import { fetchSerp } from "./serp";
import { isBig, room, topicWords } from "./site-keywords";

/**
 * Searches the owner picked with "Rank for this". Each one is matched to the
 * page on the site that fits it best, checked against Google page one, added
 * to the daily rank check, and handed to the autopilot (apps/targets.ts) ahead
 * of everything else. When page one is all big publishers, easier searches on
 * the same topic are suggested alongside.
 */

export interface Target {
  keyword: string;
  /** The page that should rank for it; null when no page on the site is about it yet. */
  page: string | null;
  monthlySearches: number;
  winnable: boolean | null;
  why: string;
  addedAt: string;
  /** A new article the autopilot wrote for it (see new-articles.ts). */
  article?: { url: string | null; live: boolean; note: string };
}

export interface TargetResult {
  target: Target;
  /** Related searches with room on page one, best first. */
  easier: { keyword: string; monthlySearches: number; why: string }[];
}

const KEY = (accountId: string) => `targets:${accountId}`;
const TARGETING = { geo: "2840", language: "1000" };
const MAX_TARGETS = 30;

export async function readTargets(accountId: string): Promise<Target[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as Target[]) : [];
}

async function saveTargets(accountId: string, targets: Target[]): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(targets.slice(0, MAX_TARGETS))})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The page whose title, heading and address share the most meaningful words with the search. */
async function bestPage(accountId: string, keyword: string): Promise<string | null> {
  const want = topicWords(keyword);
  if (!want.size) return null;
  let best: { url: string; score: number } | null = null;
  for (const p of await sitePages(accountId)) {
    if (p.noindex) continue;
    const have = topicWords(`${p.h1 ?? ""} ${p.title ?? ""} ${new URL(p.url).pathname.replace(/[-/]/g, " ")}`);
    const shared = [...want].filter((w) => have.has(w)).length;
    if (!shared) continue;
    // Articles are easier to aim at one search than the home page or a category.
    const score = shared / want.size + (isPostUrl(p.url) ? 0.1 : 0);
    if (!best || score > best.score) best = { url: p.url, score };
  }
  return best && best.score >= 0.5 ? best.url : null;
}

function describe(small: number, ours: number | null): string {
  if (ours !== null) return `You're #${ours} on Google; ${small} smaller sites on page 1`;
  return small >= 3 ? `${small} smaller sites on page 1, so there's room` : "Page 1 is mostly big health sites, so this one is hard";
}

export async function addTarget(
  accountId: string,
  keyword: string,
  opts: { serperKey: string | null; ourDomain: string; monthlySearches?: number }
): Promise<TargetResult> {
  const k = keyword.trim().toLowerCase();
  const page = await bestPage(accountId, k);
  let winnable: boolean | null = null;
  let why = "Page 1 not checked (no search results key)";
  const easier: TargetResult["easier"] = [];

  if (opts.serperKey) {
    const serp = await fetchSerp(opts.serperKey, k);
    const r = room(serp.organic, opts.ourDomain);
    winnable = r.ours !== null || r.small >= 3;
    why = describe(r.small, r.ours);
    // Easier searches on the same topic: Google's related searches with real volume and room on page one.
    const related = (await keywordVolumes({ ...TARGETING, keywords: serp.related }).catch(() => []))
      .filter((i) => (i.avgMonthlySearches ?? 0) >= 50 && i.keyword.toLowerCase() !== k)
      .sort((a, b) => (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0))
      .slice(0, 4);
    for (const i of related) {
      const s = await fetchSerp(opts.serperKey, i.keyword).catch(() => null);
      if (!s) continue;
      const rr = room(s.organic, opts.ourDomain);
      if (rr.ours !== null || rr.small >= 3) easier.push({ keyword: i.keyword.toLowerCase(), monthlySearches: i.avgMonthlySearches ?? 0, why: describe(rr.small, rr.ours) });
    }
    // A big publisher at #1 to #3 with no small sites at all: say so plainly.
    if (!winnable && serp.organic.slice(0, 3).every((o) => isBig(o.domain))) why = `${why} (${serp.organic[0]?.domain ?? ""} is #1)`;
  }

  const monthlySearches =
    opts.monthlySearches ?? (await keywordVolumes({ ...TARGETING, keywords: [k] }).catch(() => []))[0]?.avgMonthlySearches ?? 0;
  const before = (await readTargets(accountId)).find((t) => t.keyword === k);
  const target: Target = {
    keyword: k,
    page: page ?? (before?.article?.live ? before.article.url : null),
    monthlySearches,
    winnable,
    why,
    addedAt: new Date().toISOString(),
    ...(before?.article ? { article: before.article } : {}),
  };
  const others = (await readTargets(accountId)).filter((t) => t.keyword !== k);
  await saveTargets(accountId, [target, ...others]);

  // Checked on Google every day, first in line, and shown in Rank tracker.
  const lists = await getLists(accountId);
  const list = lists.find((l) => l.name === "Rank for this") ?? (await createList(accountId, "Rank for this"));
  if (!list.keywords.includes(k)) await addKeywords(accountId, list.id, [k]);

  return { target, easier };
}

/** Replaces one target (by keyword), keeping the others. */
export async function saveTarget(accountId: string, target: Target): Promise<void> {
  const all = await readTargets(accountId);
  await saveTargets(accountId, all.map((t) => (t.keyword === target.keyword ? target : t)));
}

export async function removeTarget(accountId: string, keyword: string): Promise<void> {
  const k = keyword.trim().toLowerCase();
  await saveTargets(accountId, (await readTargets(accountId)).filter((t) => t.keyword !== k));
}
