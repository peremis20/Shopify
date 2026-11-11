import { nullUnlessLimit } from "./usage";
import { clientListKnown, otherClient } from "./clients";
import { ensureSchema, sql } from "../db";
import { authorityOf, authorityReady } from "./authority";
import { isJunkKeyword } from "./keyword-guard";
import { fetchSerp } from "./serp";
import { isBig, readSiteKeywords } from "./site-keywords";
import { readTargets } from "./targets";
import { aiProvider, readPlatformSettings } from "./settings";
import { ownerApproves, reviewProspects } from "./writer";

/**
 * Every new find is checked by a second AI before it reaches the owner's list (no link farms, paid link sellers or
 * off topic sites). If the check can't run, the finds wait for the next search rather than going on unchecked.
 */
async function reviewed(accountId: string, ourSite: string, finds: Prospect[]): Promise<Prospect[]> {
  if (!finds.length) return finds;
  const ai = aiProvider(await readPlatformSettings());
  // Thrown, not swallowed: the list stays as it was and the next run searches again.
  if (!ai) throw new Error("Add an AI key so new backlink sites can be checked before they are listed.");
  const out: Prospect[] = [];
  for (let i = 0; i < finds.length; i += 40) {
    const chunk = finds.slice(i, i + 40);
    // The owner decides whom to email, so with one AI service the owner is the second check (the rule filters still run).
    const r = await ownerApproves(ai, () => reviewProspects(ai, ourSite, chunk)).catch((e) => {
      throw new Error(`New backlink sites couldn't be checked by the reviewing AI, so the list wasn't changed. ${(e as Error).message}`);
    });
    chunk.forEach((p, j) => r.keep[j] && out.push(p));
  }
  return out;
}

/**
 * Backlink prospects: real websites that could link to this site, found on
 * Google each week, the honest way (no paid links, no link schemes):
 * - mentions: pages that already name the brand, often without a link
 * - resources: "resources" and "useful links" pages on the site's topics
 * - guest: kept for prospects found before; "write for us" pages are no longer sought, since articles traded for
 *   links are a link scheme
 * - podcast: shows on the topic that invite guests (PR and Mentions Agent)
 * - roundup: expert roundups on the topic that collect answers (PR and Mentions Agent)
 * - broken: a page on the topic with a dead link the site can replace (Broken Link Agent, broken-links.ts)
 * - competitor: a page that mentions a competitor but not this site (Authority Coach, authority-coach.ts)
 * Each one gets an outreach email the owner can copy and send themselves.
 * Nothing is ever sent automatically.
 */

export type ProspectKind = "mention" | "resource" | "guest" | "podcast" | "roundup" | "broken" | "competitor";
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
  /** Authority Coach: the competitor this page mentions. */
  rival?: string;
  /** Outreach Drafter: the email written ahead for the owner to review and send (never sent by the app). */
  draft?: OutreachDraft;
  /** When the Outreach Drafter last tried and couldn't write a safe email: it moves on to other sites for a week. */
  draftTriedAt?: string;
  /** For a won link: whether the link to this site was really found on their page, and when it was checked. */
  linkCheck?: { at: string; found: boolean };
}

export interface OutreachDraft {
  subject: string;
  body: string;
  /** The address the site shows publicly, when one was found. */
  to: string | null;
  at: string;
}

export interface ProspectList {
  updatedAt: string;
  prospects: Prospect[];
}

const KEY = (accountId: string) => `backlinks:${accountId}`;
const WEEK = 7 * 24 * 3600 * 1000;
const MAX = 80;

/** Sites where a link is not worth chasing: social networks, marketplaces, Q&A, video. */
export const NOT_PROSPECTS =
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
    // PR and Mentions Agent: shows and roundups that want people to speak on the topic.
    queries.push({ q: `"${t}" podcast "be a guest"`, kind: "podcast", topic: t });
    queries.push({ q: `"${t}" "expert roundup"`, kind: "roundup", topic: t });
  }

  // Without the customer list this can't tell customers apart, and saving would drop the owner's list: try again later.
  if (!(await clientListKnown())) throw new Error("The customer list couldn't be read, so backlink sites weren't refreshed this time.");
  const isOtherClient = await otherClient(ourDomain);
  const found = new Map<string, Prospect>();
  for (const { q, kind, topic } of queries) {
    const serp = await fetchSerp(serperKey, q).catch(nullUnlessLimit);
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
  const unseen = [...found.values()].filter((p, i, all) => !byDomain.has(p.domain) && all.findIndex((q) => q.domain === p.domain) === i);
  for (const p of await reviewed(accountId, ours, unseen)) byDomain.set(p.domain, p);
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
  // Sites with an email already written are kept first when the list is full.
  const room = Math.max(0, MAX - marked.length);
  const keepIds = new Set([...fresh].sort((a, b) => Number(Boolean(b.draft)) - Number(Boolean(a.draft))).slice(0, room).map((p) => p.url));
  const list = { updatedAt: new Date().toISOString(), prospects: [...fresh.filter((p) => keepIds.has(p.url)), ...marked] };
  // Emails written while the search ran (by the owner or the Outreach Drafter) are kept, not overwritten.
  const now = await readProspects(accountId).catch(() => null);
  const written = new Map((now?.prospects ?? []).filter((p) => p.draft).map((p) => [p.url, p.draft!]));
  list.prospects = list.prospects.map((p) => (!p.draft && p.status === "new" && written.has(p.url) ? { ...p, draft: written.get(p.url) } : p));
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

/** Which finds are worth most when the list is full: a fixable broken link first, a site that only mentions a competitor last. */
const KIND_VALUE: Record<string, number> = { broken: 0, mention: 1, resource: 2, roundup: 3, podcast: 4, guest: 5, competitor: 6 };

/** When new finds must be trimmed to `room`: the most valuable kinds and strongest sites stay, in their listed order. */
export function keepBestFresh<P extends { kind: string; authority: number | null; draft?: unknown }>(fresh: P[], room: number): P[] {
  if (fresh.length <= room) return fresh;
  // A site with an email already written stays first.
  const best = new Set(
    [...fresh].sort((a, b) => Number(Boolean(b.draft)) - Number(Boolean(a.draft)) || (KIND_VALUE[a.kind] ?? 9) - (KIND_VALUE[b.kind] ?? 9) || (b.authority ?? 0) - (a.authority ?? 0)).slice(0, room)
  );
  return fresh.filter((p) => best.has(p));
}

/**
 * Upgrades prospects with what another agent found (the Broken Link Agent), keeping the owner's marks.
 * Each update replaces a new prospect on the same page, or is added when the page isn't listed.
 */
/** Returns the addresses that made it onto the list (after the second AI's check). */
export async function upsertProspects(accountId: string, updates: Prospect[], ourSite = "this website"): Promise<Set<string>> {
  const list = (await readProspects(accountId)) ?? { updatedAt: new Date().toISOString(), prospects: [] };
  // Sites not on the list yet are checked by the second AI first; upgrades to a listed page were checked when found.
  const listed = new Set(list.prospects.map((p) => p.url));
  const newOnes = updates.filter((u) => !listed.has(u.url));
  const passed = new Set(await reviewed(accountId, ourSite, newOnes));
  updates = updates.filter((u) => listed.has(u.url) || passed.has(u));
  for (const u of updates) {
    // The same page first. The same site only replaces a find of the same kind, so a
    // weaker kind of find never overwrites a better one (a broken link, a resource page).
    let i = list.prospects.findIndex((p) => p.url === u.url);
    if (i === -1) {
      const j = list.prospects.findIndex((p) => p.domain === u.domain);
      if (j !== -1 && list.prospects[j].kind !== u.kind) continue; // the site is already on the list
      i = j;
    }
    if (i === -1) list.prospects.unshift(u);
    else if (list.prospects[i].status === "new") {
      const cur = list.prospects[i];
      // An email written for what the page was no longer fits when the find changes: it is written again.
      const same = cur.url === u.url && cur.kind === u.kind && (cur.brokenLink ?? null) === (u.brokenLink ?? null) && (cur.ourPage ?? null) === (u.ourPage ?? null);
      const { draft, ...rest } = cur;
      list.prospects[i] = { ...rest, ...u, status: "new", ...(same && draft && !u.draft ? { draft } : {}) };
    }
  }
  // Same cap as the weekly search: the owner's marks always stay; when new finds must be
  // trimmed, the most valuable kinds and strongest sites stay, in their listed order.
  const marked = list.prospects.filter((p) => p.status !== "new");
  const fresh = list.prospects.filter((p) => p.status === "new");
  const kept = keepBestFresh(fresh, Math.max(0, MAX - marked.length));
  await save(accountId, { ...list, prospects: [...kept, ...marked] });
  const on = new Set([...kept, ...marked].map((p) => p.url));
  return new Set(updates.map((u) => u.url).filter((u) => on.has(u)));
}

// ---------- Outreach Drafter: three emails written ahead each week, for the owner to review and send ----------

/** How many emails are written ahead each week. */
export const DRAFTS_PER_WEEK = 3;

/** Sites with autopilot on whose drafts are more than a week old (or never made). */
export async function accountsDueForDrafts(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'drafts_at:' || a.account_id
    LEFT JOIN insights_settings q ON q.key = 'draft_queue:' || a.account_id
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days'
      -- A failed week (an AI outage) is tried again 3 hours later, not a week later.
      OR (s.value::jsonb->>'note' LIKE 'failed:%' AND s.updated_at < now() - interval '3 hours')
      -- Part of the week's emails written: the rest next hour (one slow AI never holds up the other agents).
      OR (s.value::jsonb->>'note' LIKE 'partial:%' AND s.updated_at < now() - interval '50 minutes')
      -- The Strategist sent a site to write to first: done on the next hour.
      OR (q.value IS NOT NULL AND q.value <> '[]' AND q.updated_at > s.updated_at))
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export async function markDraftsMade(accountId: string, note: string): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`drafts_at:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), note })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The open sites most worth an email that have none written yet: the most valuable kinds, then the strongest sites. */
export function pickForDrafts(list: ProspectList | null, n = DRAFTS_PER_WEEK, first: string[] = []): Prospect[] {
  const open = (list?.prospects ?? []).filter((p) => p.status === "new");
  const waiting = open.filter((p) => p.draft).length;
  // Sites the Strategist sent come first, and are written even when three emails already wait.
  const rank = (p: Prospect) => (first.includes(p.domain) ? first.indexOf(p.domain) : 99);
  const fresh = (p: Prospect) => !p.draft && !(p.draftTriedAt && Date.now() - Date.parse(p.draftTriedAt) < 7 * 864e5);
  const queued = open.filter((p) => fresh(p) && rank(p) < 99).sort((a, b) => rank(a) - rank(b));
  const rest = open
    .filter((p) => fresh(p) && rank(p) === 99)
    .sort((a, b) => (KIND_VALUE[a.kind] ?? 9) - (KIND_VALUE[b.kind] ?? 9) || (b.authority ?? 0) - (a.authority ?? 0));
  return [...queued.slice(0, n), ...rest.slice(0, Math.max(0, n - waiting - queued.length))];
}

/** Notes the sites whose email couldn't be written safely, so the next tries go to other sites. */
export async function markDraftTried(accountId: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const list = await readProspects(accountId);
  if (!list) return;
  const at = new Date().toISOString();
  list.prospects = list.prospects.map((p) => (urls.includes(p.url) ? { ...p, draftTriedAt: at } : p));
  await save(accountId, list);
}

/** Saves written emails onto their sites, reading the list fresh so the owner's marks made meanwhile are kept. */
export async function saveDrafts(accountId: string, drafts: Map<string, OutreachDraft>): Promise<number> {
  const list = await readProspects(accountId);
  if (!list || drafts.size === 0) return 0;
  let n = 0;
  list.prospects = list.prospects.map((p) => {
    const d = drafts.get(p.url);
    if (!d || p.status !== "new") return p;
    n++;
    return { ...p, draft: d };
  });
  await save(accountId, list);
  return n;
}

// ---------- Link checker: a link the owner marked won is confirmed on the other site's page ----------

/** Sites with a won link not checked in the last week. */
export async function accountsDueForLinkCheck(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    JOIN insights_settings s ON s.key = 'backlinks:' || a.account_id
    LEFT JOIN insights_settings t ON t.key = 'linkcheck_at:' || a.account_id
    WHERE a.enabled AND s.value LIKE '%"status":"won"%' AND (t.updated_at IS NULL OR t.updated_at < now() - interval '7 days'
      OR s.updated_at > t.updated_at)
    ORDER BY t.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/**
 * Reads each page the owner marked "Got the link" and looks for a link to this site on it. Checked weekly, so a
 * link that was removed later shows too. Only the other site's public page is read.
 */
export async function checkWonLinks(accountId: string, ourDomain: string): Promise<string> {
  const { safeFetch, readCapped } = await import("./broken-links");
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`linkcheck_at:${accountId}`}, ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const list = await readProspects(accountId);
  const ours = ourDomain.toLowerCase().replace(/^www\./, "");
  if (!list || !ours) return "nothing to check";
  const due = list.prospects.filter((p) => p.status === "won" && (!p.linkCheck || Date.now() - Date.parse(p.linkCheck.at) > 6 * 864e5)).slice(0, 10);
  if (!due.length) return "nothing to check";
  const results = new Map<string, { at: string; found: boolean }>();
  for (const p of due) {
    const res = await safeFetch(p.url, "GET", 12_000).catch(() => null);
    if (!res || res === "unresolved" || !res.ok) {
      if (res && res !== "unresolved") await res.body?.cancel().catch(() => undefined);
      continue; // couldn't read it this time: checked again next week, never marked missing from one miss
    }
    const html = await readCapped(res, 3_000_000).catch(() => "");
    if (!html) continue;
    const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const found = hrefs.some((h) => {
      try {
        const host = new URL(h, p.url).hostname.toLowerCase().replace(/^www\./, "");
        return host === ours || host.endsWith(`.${ours}`);
      } catch {
        return false;
      }
    });
    results.set(p.url, { at: new Date().toISOString(), found });
  }
  // Read fresh before saving, so the owner's marks made meanwhile stay.
  const now = await readProspects(accountId);
  if (!now) return "nothing to check";
  now.prospects = now.prospects.map((p) => (results.has(p.url) && p.status === "won" ? { ...p, linkCheck: results.get(p.url)! } : p));
  await save(accountId, now);
  const found = [...results.values()].filter((r) => r.found).length;
  return `${results.size} won ${results.size === 1 ? "link" : "links"} checked, ${found} found`;
}
