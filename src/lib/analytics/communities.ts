import { ensureSchema, sql } from "./db";
import { getConnection } from "./connection";
import { allowsFaith, healthRulesApply, readProfile, siteBrief } from "./profile";
import { querySearches28d } from "./seo-tools";
import { sitePages } from "./site-crawl";
import { isJunkKeyword } from "./autopilot/keyword-guard";
import { aiProvider, readPlatformSettings } from "./autopilot/settings";
import { readSiteKeywords } from "./autopilot/site-keywords";
import { report } from "./autopilot/status";
import { secondCheck, writeCommunityAnswers } from "./autopilot/writer";
import { cleanPost, normUrl } from "./social-agent";

/**
 * Communities to join: nothing here joins a group or posts anywhere. For the owner, a short list of where people ask
 * about the site's topics, given as a search to run on a well known kind of public community (never a made up group
 * name or member count), each with a helpful answer drafted from the site's own page, checked like any post, that the
 * owner can post themselves. Drawn from the site's own top searches and its profile; refreshed weekly.
 */

export interface CommunityIdea {
  /** The kind of public community, e.g. "Facebook Groups". */
  where: string;
  /** What to search for there: one of the site's own searches, plus its town for local places. */
  search: string;
  /** The site's page the answer comes from. */
  pageUrl: string;
  answer: string;
  checked: "ai" | "owner";
}

const PLACES = ["Facebook Groups", "Reddit", "Quora"];
const LOCAL_PLACES = ["Nextdoor", "Facebook Groups"];
const QUESTION = /^(?:how|what|why|when|which|who|where|can|does|do|is|are|should|will)\b/i;
const keyOf = (accountId: string) => `communities:${accountId}`;

/** A place the business serves in person (a town or region), not "online" or "worldwide". */
export function localPlace(location: string | null | undefined): string | null {
  const l = location?.trim();
  if (!l || /\b(?:online|everywhere|worldwide|world|global|international|nationwide|anywhere|internet)\b/i.test(l)) return null;
  return l.split(/[,;]/)[0].trim().slice(0, 40) || null;
}

/**
 * Up to three suggestions from the site's own searches (questions first), each tied to the page that answers it. Each
 * is a search phrase on a well known community type; local businesses also get their town on a local place.
 */
export function suggestCommunities(
  searches: { query: string; page: string; weight: number }[],
  location: string | null | undefined,
  brand: string | null | undefined,
  n = 3,
): { where: string; search: string; query: string; page: string }[] {
  const brandWord = brand?.trim().toLowerCase();
  const byQuery = new Map<string, { query: string; page: string; weight: number }>();
  for (const s of searches) {
    const q = s.query.trim().toLowerCase();
    if (!q || q.split(/\s+/).length < 2 || (brandWord && q.includes(brandWord))) continue;
    const cur = byQuery.get(q);
    if (!cur || s.weight > cur.weight) byQuery.set(q, { query: q, page: s.page, weight: s.weight });
  }
  const ranked = [...byQuery.values()].sort((a, b) => Number(QUESTION.test(b.query)) - Number(QUESTION.test(a.query)) || b.weight - a.weight);
  const town = localPlace(location);
  const out: { where: string; search: string; query: string; page: string }[] = [];
  const pagesUsed = new Set<string>();
  for (const r of ranked) {
    if (out.length >= n) break;
    // One idea per page, so the answers aren't the same page three times.
    if (pagesUsed.has(normUrl(r.page))) continue;
    pagesUsed.add(normUrl(r.page));
    const i = out.length;
    out.push(town && i === 0 ? { where: LOCAL_PLACES[0], search: `${r.query} ${town}`, query: r.query, page: r.page } : { where: PLACES[i % PLACES.length], search: r.query, query: r.query, page: r.page });
  }
  return out;
}

/** The plain line the owner reads: where to look and what to search for. */
export const communityLine = (c: Pick<CommunityIdea, "where" | "search">) => `Search ${c.where} for: ${c.search}`;

export async function readCommunities(accountId: string): Promise<{ at: string | null; items: CommunityIdea[] }> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${keyOf(accountId)}`;
  try {
    const v = row?.value ? JSON.parse(String(row.value)) : null;
    return { at: v?.at ?? null, items: Array.isArray(v?.items) ? (v.items as CommunityIdea[]) : [] };
  } catch {
    return { at: null, items: [] };
  }
}

async function saveCommunities(accountId: string, items: CommunityIdea[]): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${keyOf(accountId)}, ${JSON.stringify({ at: new Date().toISOString(), items })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** Sites with the autopilot on whose list is a week old or missing. */
export async function accountsDueForCommunities(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'communities:' || a.account_id::text
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** Makes this week's list for one site. Returns a line for the log. */
export async function refreshCommunities(accountId: string): Promise<string> {
  try {
    return await buildCommunities(accountId);
  } catch (e) {
    const reason = (e as Error).message;
    // Tried this week either way (last week's list stays), so a failing site never holds up the others; the Inspector sees it.
    await readCommunities(accountId)
      .then((c) => saveCommunities(accountId, c.items))
      .catch((err) => console.error(`communities: couldn't mark account ${accountId} tried: ${(err as Error).message}`));
    void report("communities", false, reason);
    throw e;
  }
}

async function buildCommunities(accountId: string): Promise<string> {
  const profile = await readProfile(accountId);
  const health = healthRulesApply(profile);
  const faith = allowsFaith(profile.businessType);
  const searches: { query: string; page: string; weight: number }[] = [];
  const conn = await getConnection(accountId).catch(() => null);
  if (conn?.gscSiteUrl) {
    try {
      for (const r of await querySearches28d(conn)) searches.push({ query: r.query, page: r.page, weight: r.impressions });
    } catch (e) {
      console.warn(`communities: search console not read for account ${accountId}: ${(e as Error).message}`);
    }
  }
  for (const k of await readSiteKeywords(accountId).catch(() => [])) searches.push({ query: k.keyword, page: k.page, weight: k.monthlySearches / 10 });
  const pages = await sitePages(accountId);
  const byUrl = new Map(pages.filter((p) => p.text.split(/\s+/).length >= 120).map((p) => [normUrl(p.url), p]));
  // Only searches a page of the site really answers, and never junk searches.
  const usable = searches.filter((s) => byUrl.has(normUrl(s.page)) && !isJunkKeyword(s.query, { faith }));
  const ideas = suggestCommunities(usable, profile.about?.location, profile.brandName);
  if (!ideas.length) {
    await saveCommunities(accountId, []);
    return "no searches of the site's own yet to suggest communities from";
  }
  const base = aiProvider(await readPlatformSettings());
  if (!base) {
    // Tried this week, so this site doesn't hold up the others; the missing key is on the status board already.
    await saveCommunities(accountId, (await readCommunities(accountId)).items);
    return "no AI key";
  }
  const ai = { ...base, site: siteBrief(profile) };
  const items = ideas.map((i) => ({ ...i, p: byUrl.get(normUrl(i.page))! }));
  const keep = [profile.brandName, profile.siteDomain].filter((x): x is string => Boolean(x && x.trim()));
  const answers = await writeCommunityAnswers(ai, {
    items: items.map((i) => ({ search: i.query, title: i.p.h1 || i.p.title, text: i.p.text })),
    brand: profile.brandName,
    site: profile.siteDomain ?? "this site",
    health,
  });
  const out: CommunityIdea[] = [];
  for (const [n, i] of items.entries()) {
    const clean = cleanPost(answers[n] ?? "", keep, 700, health);
    if (clean.problem || !clean.text) continue;
    const verdict = await secondCheck(ai, { what: "an answer a business owner will post in a public community", source: `${i.p.title}\n${i.p.text}`, text: clean.text, health });
    if (verdict && !verdict.ok) continue;
    out.push({ where: i.where, search: i.search, pageUrl: i.p.url, answer: clean.text, checked: verdict ? "ai" : "owner" });
  }
  await saveCommunities(accountId, out);
  void report("communities", true);
  return `${out.length} communities to join suggested`;
}
