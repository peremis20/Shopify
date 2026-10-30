import { ensureSchema, sql } from "../db";
import { keywordIdeas, keywordVolumes } from "../keywords";
import { isPostUrl, sitePages } from "../site-crawl";
import { addKeywords, createList, getLists } from "../seo-tools";
import { fetchSerp } from "./serp";
import { isBig, isLongTail, room, topicWords } from "./site-keywords";

/**
 * Searches the owner picked with "Rank for this". Each one is matched to the
 * page on the site that fits it best, checked against Google page one, added
 * to the daily rank check, and handed to the autopilot (apps/targets.ts) ahead
 * of everything else.
 *
 * Long tail first: a specific search (three words or more) is a main target.
 * A broad one ("health insurance") is kept as support: it's worked into the
 * content of the pages aiming at its long tail versions, and the best of
 * those long tail searches (with room on page one) are added as main targets
 * automatically.
 */

export interface Target {
  keyword: string;
  /** The page that should rank for it; null when no page on the site is about it yet. */
  page: string | null;
  monthlySearches: number;
  winnable: boolean | null;
  why: string;
  addedAt: string;
  /** "main": aimed at directly. "support": broad, used to back up the main ones. Main when missing (older targets). */
  role?: "main" | "support";
  /** A new article the autopilot wrote for it (see new-articles.ts). */
  article?: { url: string | null; live: boolean; note: string };
}

export interface TargetResult {
  target: Target;
  /** Long tail searches on the same topic with room on page one, best first. */
  easier: { keyword: string; monthlySearches: number; why: string }[];
  /** For a broad search: the long tail ones added as main targets for it. */
  added: string[];
}

/** How many long tail searches a broad one brings in as main targets. */
const AUTO_ADD = 2;

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
  opts: { serperKey: string | null; ourDomain: string; monthlySearches?: number },
  expand = true
): Promise<TargetResult> {
  const k = keyword.trim().toLowerCase();
  const monthlySearches =
    opts.monthlySearches ?? (await keywordVolumes({ ...TARGETING, keywords: [k] }).catch(() => []))[0]?.avgMonthlySearches ?? 0;
  const role = isLongTail(k, monthlySearches) ? "main" : "support";
  const page = await bestPage(accountId, k);
  let winnable: boolean | null = null;
  let why = "Page 1 not checked (no search results key)";
  const easier: TargetResult["easier"] = [];

  if (opts.serperKey) {
    const serp = await fetchSerp(opts.serperKey, k);
    const r = room(serp.organic, opts.ourDomain);
    winnable = r.ours !== null || r.small >= 3;
    why = describe(r.small, r.ours);
    // A big publisher at #1 to #3 with no small sites at all: say so plainly.
    if (!winnable && serp.organic.slice(0, 3).every((o) => isBig(o.domain))) why = `${why} (${serp.organic[0]?.domain ?? ""} is #1)`;

    if (expand) {
      // Long tail searches on the same topic: Keyword Planner ideas and Google's related searches,
      // three words or more, real volume, sharing the topic, then checked for room on page one.
      const want = [...topicWords(k)];
      const ideas = [
        ...(await keywordIdeas({ ...TARGETING, keywords: [k] }).catch(() => [])),
        ...(await keywordVolumes({ ...TARGETING, keywords: serp.related }).catch(() => [])),
      ];
      const seen = new Set<string>([k]);
      const longTail = ideas
        .filter((i) => {
          const kw = i.keyword.toLowerCase();
          if (seen.has(kw)) return false;
          seen.add(kw);
          const have = topicWords(kw);
          return (i.avgMonthlySearches ?? 0) >= 50 && isLongTail(kw, i.avgMonthlySearches ?? 0) && want.every((w) => have.has(w));
        })
        .sort((a, b) => (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0))
        .slice(0, 6);
      for (const i of longTail) {
        const s = await fetchSerp(opts.serperKey, i.keyword).catch(() => null);
        if (!s) continue;
        const rr = room(s.organic, opts.ourDomain);
        if (rr.ours !== null || rr.small >= 3) easier.push({ keyword: i.keyword.toLowerCase(), monthlySearches: i.avgMonthlySearches ?? 0, why: describe(rr.small, rr.ours) });
        if (easier.length >= 4) break;
      }
    }
  }

  const before = (await readTargets(accountId)).find((t) => t.keyword === k);
  const target: Target = {
    keyword: k,
    page: page ?? (before?.article?.live ? before.article.url : null),
    monthlySearches,
    winnable,
    why: role === "support" ? `Broad search, used to support its long tail ones. ${why}` : why,
    addedAt: new Date().toISOString(),
    role,
    ...(before?.article ? { article: before.article } : {}),
  };
  const others = (await readTargets(accountId)).filter((t) => t.keyword !== k);
  await saveTargets(accountId, [target, ...others]);

  // Checked on Google every day, first in line, and shown in Rank tracker.
  const lists = await getLists(accountId);
  const list = lists.find((l) => l.name === "Rank for this") ?? (await createList(accountId, "Rank for this"));
  if (!list.keywords.includes(k)) await addKeywords(accountId, list.id, [k]);

  // A broad search brings in its best long tail searches as the main targets.
  const added: string[] = [];
  if (role === "support") {
    for (const e of easier.slice(0, AUTO_ADD)) {
      await addTarget(accountId, e.keyword, { ...opts, monthlySearches: e.monthlySearches }, false);
      added.push(e.keyword);
    }
  }
  return { target, easier: easier.filter((e) => !added.includes(e.keyword)), added };
}

/** Broad targets that share a topic with a search: worked into its content as support. */
export function supportingTargets(all: Target[], keyword: string): string[] {
  const want = topicWords(keyword);
  return all
    .filter((t) => t.role === "support" && t.keyword !== keyword && [...topicWords(t.keyword)].every((w) => want.has(w)))
    .map((t) => t.keyword);
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
