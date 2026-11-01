import { clientListKnown, otherClient } from "./clients";
import { ensureSchema, sql } from "../db";
import { authorityOf, authorityReady } from "./authority";
import { isJunkKeyword } from "./keyword-guard";
import { fetchSerp } from "./serp";
import { isBig, readSiteKeywords } from "./site-keywords";
import { readTargets } from "./targets";

/**
 * Backlink prospects: real websites that could link to this site, found on
 * Google each week, the honest way (no paid links, no link schemes):
 * - mentions: pages that already name the brand, often without a link
 * - resources: "resources" and "useful links" pages on the site's topics
 * - guest: sites on the topic that ask for guest articles ("write for us")
 * - podcast: shows on the topic that invite guests (PR and Mentions Agent)
 * - roundup: expert roundups on the topic that collect answers (PR and Mentions Agent)
 * - broken: a page on the topic with a dead link the site can replace (Broken Link Agent, broken-links.ts)
 * Each one gets an outreach email the owner can copy and send themselves.
 * Nothing is ever sent automatically.
 */

export type ProspectKind = "mention" | "resource" | "guest" | "podcast" | "roundup" | "broken";
export type ProspectStatus = "new" | "contacted" | "won" | "skip";

export interface Prospect {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  kind: ProspectKind;
  topic: string;
  /** Open PageRank, 0 to 10, when known. */
  authority: number | null;
  status: ProspectStatus;
  foundAt: string;
  /** When the owner last changed the status (e.g. the day a link was won). */
  statusAt?: string;
  /** Broken Link Agent: the dead link on their page, its link text, and the site's page to offer instead. */
  brokenLink?: string;
  anchor?: string;
  ourPage?: string | null;
}

export interface ProspectList {
  updatedAt: string;
  prospects: Prospect[];
}

const KEY = (accountId: string) => `backlinks:${accountId}`;
const WEEK = 7 * 24 * 3600 * 1000;
const MAX = 80;

/** Sites where a link is not worth chasing: social networks, marketplaces, Q&A, video. */
const NOT_PROSPECTS =
  /(^|\.)(facebook|instagram|twitter|x|tiktok|linkedin|pinterest|youtube|reddit|quora|amazon|ebay|walmart|etsy|target|wikipedia|google|yelp|tripadvisor|indeed|glassdoor|medium)\.[a-z.]+$/i;

export async function readProspects(accountId: string): Promise<ProspectList | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as ProspectList) : null;
}

async function save(accountId: string, list: ProspectList): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(list)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const prospectsDue = (list: ProspectList | null) => !list || Date.now() - new Date(list.updatedAt).getTime() > WEEK;

/** The site's topics to find links for: its main searches, Easy ones first. */
async function topics(accountId: string): Promise<string[]> {
  const [targets, kws] = await Promise.all([readTargets(accountId).catch(() => []), readSiteKeywords(accountId).catch(() => [])]);
  const all = [
    ...targets.filter((t) => t.role !== "support").sort((a, b) => (a.difficulty ?? 50) - (b.difficulty ?? 50)),
    ...kws.filter((k) => k.role !== "support").sort((a, b) => (a.difficulty ?? 50) - (b.difficulty ?? 50)),
  ].map((k) => k.keyword);
  // Shorter topic phrases find more pages: keep the first three words.
  const out: string[] = [];
  for (const k of all) {
    const t = k.split(/\s+/).slice(0, 3).join(" ");
    if (!out.includes(t) && !isJunkKeyword(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}

/** Looks for new prospects on Google (about 7 searches), keeping what the owner already marked. */
export async function findProspects(accountId: string, serperKey: string, ourDomain: string, brand: string | null): Promise<ProspectList> {
  const old = await readProspects(accountId);
  const ours = ourDomain.toLowerCase().replace(/^www\./, "");
  const queries: { q: string; kind: ProspectKind; topic: string }[] = [];
  if (brand && brand.length > 2) queries.push({ q: `"${brand}" -site:${ours}`, kind: "mention", topic: brand });
  for (const t of await topics(accountId)) {
    queries.push({ q: `"${t}" intitle:resources`, kind: "resource", topic: t });
    queries.push({ q: `"${t}" "useful links"`, kind: "resource", topic: t });
    queries.push({ q: `"${t}" "write for us"`, kind: "guest", topic: t });
    // PR and Mentions Agent: shows and roundups that want people to speak on the topic.
    queries.push({ q: `"${t}" podcast "be a guest"`, kind: "podcast", topic: t });
    queries.push({ q: `"${t}" "expert roundup"`, kind: "roundup", topic: t });
  }

  // Without the customer list this can't tell customers apart, and saving would drop the owner's list: try again later.
  if (!(await clientListKnown())) throw new Error("The customer list couldn't be read, so backlink sites weren't refreshed this time.");
  const isOtherClient = await otherClient(ourDomain);
  const found = new Map<string, Prospect>();
  for (const { q, kind, topic } of queries) {
    const serp = await fetchSerp(serperKey, q).catch(() => null);
    for (const r of serp?.organic ?? []) {
      const domain = r.domain.toLowerCase().replace(/^www\./, "");
      if (domain === ours || domain.endsWith(`.${ours}`) || NOT_PROSPECTS.test(domain) || isBig(domain) || isOtherClient(domain)) continue;
      if (found.has(r.link)) continue;
      found.set(r.link, { url: r.link, domain, title: r.title, snippet: r.snippet ?? "", kind, topic, authority: null, status: "new", foundAt: new Date().toISOString() });
    }
  }

  // One page per site, and keep what the owner already did with a site.
  const byDomain = new Map<string, Prospect>();
  for (const p of old?.prospects ?? []) if (!isOtherClient(p.domain)) byDomain.set(p.domain, p);
  for (const p of found.values()) if (!byDomain.has(p.domain)) byDomain.set(p.domain, p);
  let prospects = [...byDomain.values()];

  if (await authorityReady()) {
    const scores = await authorityOf(prospects.map((p) => p.domain)).catch(() => new Map<string, number>());
    prospects = prospects.map((p) => ({ ...p, authority: scores.get(p.domain) ?? p.authority }));
  }
  // Open ones first, the strongest sites first within them.
  const order: Record<ProspectStatus, number> = { new: 0, contacted: 1, won: 2, skip: 3 };
  prospects.sort((a, b) => order[a.status] - order[b.status] || (b.authority ?? 0) - (a.authority ?? 0));
  // The owner's marks (emailed, won, skipped) are always kept; only new finds are capped.
  const marked = prospects.filter((p) => p.status !== "new");
  const fresh = prospects.filter((p) => p.status === "new");
  const list = { updatedAt: new Date().toISOString(), prospects: [...fresh.slice(0, Math.max(0, MAX - marked.length)), ...marked] };
  await save(accountId, list);
  return list;
}

export async function setProspectStatus(accountId: string, url: string, status: ProspectStatus): Promise<ProspectList | null> {
  const list = await readProspects(accountId);
  if (!list) return null;
  list.prospects = list.prospects.map((p) => (p.url === url ? { ...p, status, statusAt: new Date().toISOString() } : p));
  await save(accountId, { ...list });
  return list;
}

/**
 * Upgrades prospects with what another agent found (the Broken Link Agent), keeping the owner's marks.
 * Each update replaces a new prospect on the same page, or is added when the page isn't listed.
 */
export async function upsertProspects(accountId: string, updates: Prospect[]): Promise<void> {
  const list = (await readProspects(accountId)) ?? { updatedAt: new Date().toISOString(), prospects: [] };
  for (const u of updates) {
    // The same page first; the same site only when the page isn't listed.
    let i = list.prospects.findIndex((p) => p.url === u.url);
    if (i === -1) i = list.prospects.findIndex((p) => p.domain === u.domain);
    if (i === -1) list.prospects.unshift(u);
    else if (list.prospects[i].status === "new") list.prospects[i] = { ...list.prospects[i], ...u, status: "new" };
  }
  // Same cap as the weekly search: the owner's marks always stay, new finds are trimmed.
  const marked = list.prospects.filter((p) => p.status !== "new");
  const fresh = list.prospects.filter((p) => p.status === "new");
  await save(accountId, { ...list, prospects: [...fresh.slice(0, Math.max(0, MAX - marked.length)), ...marked] });
}
