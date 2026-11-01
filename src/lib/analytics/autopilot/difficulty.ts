import { ensureSchema, sql } from "../db";
import { authorityOf, authorityReady } from "./authority";
import { fetchSerp } from "./serp";
import { isBig, topicWords } from "./site-keywords";

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
}

const CACHE_DAYS = 7;
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
  if (hit) return hit;

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
  const result: Difficulty = {
    keyword: k,
    score,
    label: labelOf(score),
    avgAuthority: known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null,
    targeted,
    big,
    ours,
  };
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${`kd:${k}`}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return result;
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
