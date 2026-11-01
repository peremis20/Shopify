import { ensureSchema, sql } from "../db";
import { authorityOf, authorityReady } from "./authority";
import { fetchSerp } from "./serp";
import { isBig, topicWords } from "./site-keywords";
import { junkReason } from "./keyword-guard";

/**
 * Keyword difficulty from 0 to 100, built from what ranks on Google page one
 * (the way paid tools do it, from data the app already has):
 * - how strong the ranking sites are (Open PageRank authority), 60 points
 * - how many of them aim their title squarely at the search, 25 points
 * - how many are big publishers or marketplaces, 15 points
 * Easy under 35, Medium under 60, Hard from 60. Cached for a week per search.
 */

export type DifficultyLabel = "easy" | "medium" | "hard";

export interface Difficulty {
  keyword: string;
  score: number;
  label: DifficultyLabel;
  /** Average authority of page one (0 to 10), when Open PageRank knows the sites. */
  avgAuthority: number | null;
  /** Page one results whose title targets the search directly. */
  targeted: number;
  /** Page one results from big publishers or marketplaces. */
  big: number;
  /** This site's position on page one, if it's there. */
  ours: number | null;
  /** A local search ("near me"): Google shows map listings first, so an article can't win it whatever the score. */
  local?: boolean;
}

const CACHE_DAYS = 7;
/** Easy first, then Medium, then Hard; unscored in the middle. */
export const easeRank = (score: number | null | undefined) => (score == null ? 1.5 : score < 35 ? 0 : score < 60 ? 1 : 2);
/** How much an easier search is worth chasing compared with a harder one of the same size (about 1.6 for Easy, 0.6 for Hard). */
export const easeFactor = (score: number | null | undefined) => (score == null ? 1 : Math.max(0.4, (100 - score) / 50));
export const labelOf = (score: number): DifficultyLabel => (score < 35 ? "easy" : score < 60 ? "medium" : "hard");

async function cached(keyword: string): Promise<Difficulty | null> {
  await ensureSchema();
  const [row] = await sql`
    SELECT data FROM insights_report_cache
    WHERE cache_key = ${`kd:${keyword}`} AND fetched_at > now() - make_interval(days => ${CACHE_DAYS})`;
  return row?.data ? (JSON.parse(row.data) as Difficulty) : null;
}

export async function keywordDifficulty(keyword: string, serperKey: string, ourDomain = ""): Promise<Difficulty> {
  const k = keyword.trim().toLowerCase();
  const hit = await cached(k);
  // The shared cache holds only public facts about page one; where this site ranks is looked up for this site alone.
  if (hit) return { ...hit, ours: await ourPosition(serperKey, k, ourDomain) };

  const serp = await fetchSerp(serperKey, k);
  const top = serp.organic.slice(0, 10);
  const scores = (await authorityReady()) ? await authorityOf(top.map((r) => r.domain)).catch(() => new Map<string, number>()) : new Map<string, number>();

  const known = top.map((r) => scores.get(r.domain.replace(/^www\./, ""))).filter((s): s is number => s !== undefined);
  // Sites Open PageRank doesn't know: big publishers count as strong, the rest as small.
  const authorityFor = (domain: string) => scores.get(domain.replace(/^www\./, "")) ?? (isBig(domain) ? 7 : 3);
  const avg = top.length ? top.reduce((s, r) => s + authorityFor(r.domain), 0) / top.length : 0;

  const want = [...topicWords(k)];
  const targeted = top.filter((r) => {
    const have = topicWords(r.title);
    return want.length > 0 && want.every((w) => have.has(w));
  }).length;
  const big = top.filter((r) => isBig(r.domain)).length;
  const n = Math.max(top.length, 1);

  const score = Math.max(0, Math.min(100, Math.round((avg / 10) * 60 + (targeted / n) * 25 + (big / n) * 15)));
  const ours = top.find((r) => ourDomain && (r.domain === ourDomain || r.domain.endsWith(`.${ourDomain}`)))?.position ?? null;
  const shared: Difficulty = {
    keyword: k,
    score,
    label: labelOf(score),
    avgAuthority: known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null,
    targeted,
    big,
    ours: null,
    ...(junkReason(k, { faith: true }) === "local search" ? { local: true } : {}),
  };
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${`kd:${k}`}, ${JSON.stringify(shared)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return { ...shared, ours };
}

/** This site's spot on page one for a search (from the day's cached page one, so no extra cost). */
async function ourPosition(serperKey: string, k: string, ourDomain: string): Promise<number | null> {
  if (!ourDomain) return null;
  const serp = await fetchSerp(serperKey, k).catch(() => null);
  return serp?.organic.slice(0, 10).find((r) => r.domain === ourDomain || r.domain.endsWith(`.${ourDomain}`))?.position ?? null;
}

/** Scores for a list of searches, a few at a time (each one is a page one lookup, cached a day). */
export async function difficulties(keywords: string[], serperKey: string, ourDomain = ""): Promise<Difficulty[]> {
  const list = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 25);
  const out: Difficulty[] = [];
  for (let i = 0; i < list.length; i += 5) {
    const batch = await Promise.all(list.slice(i, i + 5).map((k) => keywordDifficulty(k, serperKey, ourDomain).catch(() => null)));
    for (const d of batch) if (d) out.push(d);
  }
  return out;
}

/**
 * Fills in missing scores on the searches the autopilot works on (Rank for this
 * targets and the site's keyword list), a few per run, so ones picked before
 * scores existed still get ordered Easy first. Page one lookups are cached.
 */
export async function backfillDifficulty(accountId: string, serperKey: string, ourDomain: string, max = 8): Promise<number> {
  const { readTargets, saveTarget } = await import("./targets");
  const { readSiteKeywordsRaw, saveSiteKeywordsRaw } = await import("./site-keywords");
  let done = 0;
  for (const t of await readTargets(accountId)) {
    if (done >= max) break;
    if (t.difficulty !== undefined || t.role === "support") continue;
    const d = await keywordDifficulty(t.keyword, serperKey, ourDomain).catch(() => null);
    if (!d) continue;
    await saveTarget(accountId, { ...t, difficulty: d.score });
    done++;
  }
  const items = await readSiteKeywordsRaw(accountId);
  let changed = false;
  for (const k of items) {
    if (done >= max) break;
    if (k.difficulty !== undefined || k.role === "support") continue;
    const d = await keywordDifficulty(k.keyword, serperKey, ourDomain).catch(() => null);
    if (!d) continue;
    k.difficulty = d.score;
    changed = true;
    done++;
  }
  if (changed) await saveSiteKeywordsRaw(accountId, items);
  return done;
}
