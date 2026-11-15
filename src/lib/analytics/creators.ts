import { ensureSchema, sql } from "./db";
import { getConnection } from "./connection";
import { resolveRange } from "./dates";
import { campaignStats } from "./ga4";
import { facebookSchema, getFacebook, MetaApiError, metaCall, type FacebookLink } from "./facebook";
import { healthRulesApply, readProfile, siteBrief, type Profile } from "./profile";
import { querySearches28d } from "./seo-tools";
import { sitePages } from "./site-crawl";
import { taggedUrl } from "./threads";
import { pageKind, topicTerms } from "./landing";
import { claimProblem, cleanPost, noDashes } from "./social-agent";
import { scanClaims } from "./autopilot/claims";
import { otherClient, otherClientHandles } from "./autopilot/clients";
import { isSabbath } from "./autopilot/sabbath";
import { aiProvider, readAccountAutopilot, readPlatformSettings } from "./autopilot/settings";
import { readSiteKeywords } from "./autopilot/site-keywords";
import { report } from "./autopilot/status";
import { secondCheck, writeCreatorMessage } from "./autopilot/writer";

/**
 * The creator finder: Instagram creators a site's owner could ask to promote its products. Weekly per site with the
 * autopilot on and Instagram connected (never in the Sabbath), from whichever of Meta's sources the connection can use,
 * in this order: the Instagram Creator Marketplace search, hashtag search (Meta allows 30 different hashtags in seven
 * days per account, tracked here), and business discovery for the public numbers of each account found or added by the
 * owner. Topics come only from the site's own searches, products and profile. Every number shown was fetched; nothing
 * is guessed. Other customers' accounts are never suggested. The owner drafts a message (at most five a week), which
 * passes the claim guard and a second AI, and sends it themselves: nothing is ever sent from here.
 */

/** Meta's documented Creator Marketplace search on the brand's Instagram account. Easy to change if Meta renames it. */
export const MARKETPLACE_EDGE = "creator_marketplace_creators";
export const MARKETPLACE_SCOPE = "instagram_creator_marketplace_discovery";
/** Meta's limit: different hashtags one Instagram account may search in seven days. */
export const HASHTAG_WEEKLY_LIMIT = 30;
/** Hashtags one weekly run uses, so a site keeps room for the next weeks. */
const HASHTAGS_PER_RUN = 5;
/** Accounts looked up with business discovery per run. */
const LOOKUPS_PER_RUN = 15;
/** Message drafts per site in seven days. */
export const CREATOR_DRAFT_CAP = 5;
/** Recent posts needed before an engagement rate means anything. */
const MIN_POSTS = 3;

export type SourceState = "ok" | "missing" | "error" | "unknown";
export interface Capabilities {
  marketplace: SourceState;
  hashtags: SourceState;
  discovery: SourceState;
}

// ---------- pure parts (tested) ----------

/** Whether the Creators card shows at all: only with an Instagram business account connected. */
export const showCreators = (link: Pick<FacebookLink, "igUserId"> | null | undefined) => Boolean(link?.igUserId);

/** A handle as Instagram writes it: lower case letters, digits, dots and underscores. */
export const cleanHandle = (h: string) => h.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 30);

/** The creator's own tracked link to the site: utm_source=instagram, utm_medium=creator, utm_campaign=creator_<handle>. */
export function creatorLink(siteUrl: string, handle: string): string {
  return taggedUrl(siteUrl, "instagram", `creator_${cleanHandle(handle)}`, "creator");
}

/**
 * Hashtags this run may search: ones already searched in the last seven days don't count again; new ones only while
 * fewer than the weekly limit of different hashtags were used.
 */
export function hashtagsAllowed(used: { tag: string; at: string }[], wanted: string[], now = Date.now(), limit = HASHTAG_WEEKLY_LIMIT): string[] {
  const inWindow = new Set(used.filter((u) => now - Date.parse(u.at) < 7 * 86400_000).map((u) => u.tag));
  let count = inWindow.size;
  const out: string[] = [];
  for (const t of wanted) {
    if (out.includes(t)) continue;
    if (inWindow.has(t)) out.push(t);
    else if (count < limit) {
      out.push(t);
      count++;
    }
  }
  return out;
}

/** A hashtag from a topic: its words run together, letters and digits only. */
export const hashtagOf = (topic: string) => topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Mentioned accounts in public captions (how hashtag posts point to creators; Meta doesn't name a hashtag post's author). */
export const mentionsIn = (caption: string) => [...caption.matchAll(/(?:^|[^\w.])@([a-z0-9._]{2,30})/gi)].map((m) => cleanHandle(m[1].replace(/\.+$/, ""))).filter((h) => h.length >= 2);

export interface FetchedPost {
  caption?: string | null;
  like_count?: number | null;
  comments_count?: number | null;
}

/** Engagement rate from fetched recent posts: average likes plus comments over followers. Null without enough real numbers. */
export function engagementRate(posts: FetchedPost[], followers: number | null | undefined): { rate: number; posts: number } | null {
  if (!followers || followers <= 0) return null;
  const counted = posts.filter((p) => typeof p.like_count === "number" && typeof p.comments_count === "number");
  if (counted.length < MIN_POSTS) return null;
  const total = counted.reduce((a, p) => a + (p.like_count as number) + (p.comments_count as number), 0);
  return { rate: total / counted.length / followers, posts: counted.length };
}

/** How well a creator's own words (bio and captions) fit the site's topics: share of topic words they use, 0 to 1. */
export function topicFit(creatorText: string, topicWords: Set<string>): { fit: number; matched: string[] } {
  if (!topicWords.size) return { fit: 0, matched: [] };
  const theirs = topicTerms(creatorText);
  const matched = [...topicWords].filter((w) => theirs.has(w));
  return { fit: Math.min(1, matched.length / Math.min(topicWords.size, 8)), matched };
}

/** The fit score, 0 to 100: topic fit counts most; engagement adds up to 40 (a rate of five percent or more is full marks). */
export function creatorScore(fit: number, rate: number | null): number {
  return Math.round(100 * (0.6 * fit + 0.4 * (rate === null ? 0 : Math.min(rate / 0.05, 1))));
}

/** Risky health wording in recent captions (the claim guard), as the phrases found. */
export function claimFlags(captions: string[]): string[] {
  return [...new Set(captions.flatMap((c) => scanClaims(c).map((f) => f.phrase)))].slice(0, 5);
}

const PROMO = /#ad\b|#sponsored\b|#partner\b|paid partnership|\buse (?:my )?code\b|\bdiscount code\b|\bpromo code\b|\baffiliate\b|\bgifted\b|\bcollab\b/i;

/**
 * A recent sponsored post for a product like the site's own (all the meaning words of one of its product names, with a
 * promotion sign such as #ad or a discount code) that doesn't mention the site's brand: it may be a direct competitor's.
 */
export function competitorFlag(captions: string[], productNames: string[], brand: string | null | undefined): string | null {
  const brandWord = brand?.trim().toLowerCase();
  for (const c of captions) {
    if (!PROMO.test(c) || (brandWord && c.toLowerCase().includes(brandWord))) continue;
    const words = topicTerms(c);
    const hit = productNames.find((n) => {
      const need = topicTerms(n);
      if (brandWord) for (const b of topicTerms(brandWord)) need.delete(b);
      return need.size > 0 && [...need].every((w) => words.has(w));
    });
    if (hit) return `A recent sponsored post promotes a product like your ${hit}.`;
  }
  return null;
}

/** What the owner reads about the sources that can't be used yet, in plain words. */
export function missingMessages(caps: Capabilities): string[] {
  const out: string[] = [];
  if (caps.discovery === "missing")
    out.push("Looking up a creator's public numbers isn't allowed yet. Click Turn on creator search and allow it (the instagram_manage_insights permission). Posting stays as it is.");
  if (caps.marketplace === "missing")
    out.push("Instagram Creator Marketplace search isn't allowed yet. It needs Meta to approve the creator marketplace permission for the app; then click Turn on creator search.");
  if (caps.hashtags === "missing") out.push("Hashtag search isn't allowed for this connection. The Meta app needs Instagram public content access.");
  if (caps.marketplace !== "ok" && caps.hashtags !== "ok" && caps.discovery !== "ok" && !out.length) out.push("No creator source has worked yet. The next weekly run tries again.");
  return out;
}

/**
 * What the recorded permissions already say: a creator permission known to be missing is "missing" without asking
 * Meta; anything else keeps what the last run found. A connection whose permissions were never recorded says nothing.
 */
export function capsFromScopes(caps: Capabilities, scopes: string[] | null): Capabilities {
  if (!scopes) return caps;
  return {
    ...caps,
    discovery: scopes.includes("instagram_manage_insights") ? caps.discovery : "missing",
    marketplace: scopes.includes(MARKETPLACE_SCOPE) ? caps.marketplace : "missing",
  };
}

/** Whether the Creators card offers "Turn on creator search": some creator permission isn't known to be granted. */
export const needsCreatorLogin = (scopes: string[] | null) => !scopes || !scopes.includes("instagram_manage_insights") || !scopes.includes(MARKETPLACE_SCOPE);

/** The plain note after the "Turn on creator search" login, from what was granted (null when everything was). */
export function grantNote(granted: string[] | null): string | null {
  if (!granted) return "Creator search wasn't turned on: Facebook didn't say what was allowed. Your posting connection is unchanged. Please try again.";
  if (!granted.includes("instagram_manage_insights"))
    return "Creator search wasn't turned on: looking up public creator numbers wasn't allowed. Your posting connection is unchanged.";
  if (!granted.includes(MARKETPLACE_SCOPE))
    return "Creator search is on with hashtags and the usernames you add. Instagram Creator Marketplace search wasn't allowed; it needs Meta to approve the app for it.";
  return null;
}

/** The meaning words of the site's topics: its top searches, product names and the offer in its profile. */
export function siteTopicWords(searches: string[], productNames: string[], offer: string | null | undefined, brand: string | null | undefined): Set<string> {
  const words = new Set<string>();
  for (const t of [...searches.slice(0, 15), ...productNames, offer ?? ""]) for (const w of topicTerms(t)) words.add(w);
  for (const b of topicTerms(brand ?? "")) words.delete(b);
  return words;
}

// ---------- storage ----------

async function schema() {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_creators (
    account_id bigint NOT NULL REFERENCES insights_accounts (id) ON DELETE CASCADE,
    handle text NOT NULL,
    source text NOT NULL,
    name text,
    followers integer,
    media_count integer,
    engagement real,
    posts_counted integer,
    country text,
    fit real,
    score integer,
    matched text,
    claim_flags text,
    competitor text,
    status text NOT NULL DEFAULT 'new',
    message text,
    message_checked text,
    message_reason text,
    found_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    drafted_at timestamptz,
    PRIMARY KEY (account_id, handle)
  )`;
  // Each hashtag searched, per site, with when it was first searched in the current seven days (Meta's limit).
  await sql`CREATE TABLE IF NOT EXISTS insights_creator_hashtags (
    account_id bigint NOT NULL REFERENCES insights_accounts (id) ON DELETE CASCADE,
    tag text NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, tag)
  )`;
  // When each message draft of the last seven days was made, taken in one statement that refuses at the cap.
  await sql`CREATE TABLE IF NOT EXISTS insights_creator_drafts (
    account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
    times timestamptz[] NOT NULL DEFAULT '{}'
  )`;
}

const runKey = (accountId: string) => `creators_run:${accountId}`;
const noteKey = (accountId: string) => `creators_note:${accountId}`;

/**
 * After the "Turn on creator search" login, or when it failed: the note the owner reads. Only the creator search status
 * changes; with a new creator permission the weekly search runs again soon.
 */
export async function recordCreatorGrant(accountId: string, granted: string[] | null, failure: string | null = null): Promise<void> {
  await schema();
  const note = failure ? `Creator search wasn't turned on: ${failure} Your posting connection is unchanged.` : grantNote(granted);
  if (note) {
    await sql`
      INSERT INTO insights_settings (key, value) VALUES (${noteKey(accountId)}, ${note})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  } else await sql`DELETE FROM insights_settings WHERE key = ${noteKey(accountId)}`;
  if (!failure && granted?.includes("instagram_manage_insights")) await sql`DELETE FROM insights_settings WHERE key = ${runKey(accountId)}`;
}

export interface CreatorRow {
  handle: string;
  source: string;
  name: string | null;
  followers: number | null;
  mediaCount: number | null;
  engagement: number | null;
  postsCounted: number | null;
  country: string | null;
  fit: number | null;
  score: number | null;
  matched: string[];
  claimFlags: string[];
  competitor: string | null;
  status: "new" | "drafted" | "dismissed" | "added";
  message: string | null;
  messageChecked: "ai" | "owner" | null;
  messageReason: string | null;
  link: string | null;
  /** The owner may draft a message: not on a health site with claim flags. */
  draftable: boolean;
  stats: { visits: number; signups: number; sales: number } | null;
}

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const list = (v: unknown) => (v ? String(v).split("\n").filter(Boolean) : []);

async function readRun(accountId: string): Promise<{ at: string | null; caps: Capabilities }> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${runKey(accountId)}`;
  try {
    const v = row?.value ? JSON.parse(String(row.value)) : null;
    return { at: v?.at ?? null, caps: v?.caps ?? { marketplace: "unknown", hashtags: "unknown", discovery: "unknown" } };
  } catch {
    return { at: null, caps: { marketplace: "unknown", hashtags: "unknown", discovery: "unknown" } };
  }
}

async function saveRun(accountId: string, caps: Capabilities): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${runKey(accountId)}, ${JSON.stringify({ at: new Date().toISOString(), caps })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

async function draftsThisWeek(accountId: string): Promise<number> {
  const [row] = await sql`SELECT (SELECT count(*) FROM unnest(times) t WHERE t > now() - interval '7 days') AS n FROM insights_creator_drafts WHERE account_id = ${accountId}`;
  return Number(row?.n ?? 0);
}

const statsCache = new Map<string, { at: number; stats: Map<string, { visits: number; signups: number; sales: number }> | null }>();

/** Visits, signups and sales per creator from the site's own Analytics, when it is connected. */
async function creatorStats(accountId: string): Promise<Map<string, { visits: number; signups: number; sales: number }> | null> {
  const hit = statsCache.get(accountId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.stats;
  let stats: Map<string, { visits: number; signups: number; sales: number }> | null = null;
  const conn = await getConnection(accountId).catch(() => null);
  if (conn?.gaPropertyId) {
    const { current } = resolveRange("90d", 1);
    const rows = await campaignStats({ kind: "oauth", refreshToken: conn.refreshToken }, conn.gaPropertyId, current, "instagram", "creator").catch((e) => {
      console.warn(`creator stats not read for account ${accountId}: ${(e as Error).message}`);
      return null;
    });
    if (rows) {
      stats = new Map();
      for (const [campaign, v] of rows) if (campaign.startsWith("creator_")) stats.set(campaign.slice("creator_".length), { visits: v.visits, signups: v.signups, sales: v.sales });
    }
  }
  statsCache.set(accountId, { at: Date.now(), stats });
  return stats;
}

/** Everything the Creators card shows. */
export async function creatorsView(accountId: string) {
  await schema();
  const link = await getFacebook(accountId).catch(() => null);
  if (!showCreators(link)) return { show: false as const };
  const profile = await readProfile(accountId);
  const health = healthRulesApply(profile);
  const run = await readRun(accountId);
  const stats = await creatorStats(accountId);
  const home = profile.siteDomain ? `https://${profile.siteDomain}/` : null;
  const rows = await sql`
    SELECT * FROM insights_creators WHERE account_id = ${accountId} AND status <> 'dismissed'
    ORDER BY (status = 'drafted') DESC, score DESC NULLS LAST, followers DESC NULLS LAST LIMIT 20`;
  const creators: CreatorRow[] = rows.map((r) => {
    const flags = list(r.claim_flags);
    return {
      handle: String(r.handle),
      source: String(r.source),
      name: r.name ? String(r.name) : null,
      followers: n(r.followers),
      mediaCount: n(r.media_count),
      engagement: n(r.engagement),
      postsCounted: n(r.posts_counted),
      country: r.country ? String(r.country) : null,
      fit: n(r.fit),
      score: n(r.score),
      matched: list(r.matched),
      claimFlags: flags,
      competitor: r.competitor ? String(r.competitor) : null,
      status: String(r.status) as CreatorRow["status"],
      message: r.message ? String(r.message) : null,
      messageChecked: r.message_checked === "ai" ? "ai" : r.message_checked === "owner" ? "owner" : null,
      messageReason: r.message_reason ? String(r.message_reason) : null,
      link: home ? creatorLink(home, String(r.handle)) : null,
      // Health sites are strictest: a creator whose recent posts make medical claims is never approached.
      draftable: n(r.followers) !== null && !(health && flags.length),
      stats: stats?.get(cleanHandle(String(r.handle))) ?? null,
    };
  });
  return {
    show: true as const,
    lastRun: run.at,
    note: (await sql`SELECT value FROM insights_settings WHERE key = ${noteKey(accountId)}`)[0]?.value ?? null,
    missing: missingMessages(capsFromScopes(run.caps, link?.scopes ?? null)),
    canTurnOn: needsCreatorLogin(link?.scopes ?? null),
    creators,
    draftsThisWeek: await draftsThisWeek(accountId),
    cap: CREATOR_DRAFT_CAP,
    analytics: stats !== null,
  };
}

export async function dismissCreator(accountId: string, handle: string): Promise<void> {
  await schema();
  await sql`UPDATE insights_creators SET status = 'dismissed', updated_at = now() WHERE account_id = ${accountId} AND handle = ${cleanHandle(handle)}`;
}

/** The owner adds an account by its username: it is looked up on the next weekly run (or right away by the caller). */
export async function addCreator(accountId: string, handle: string): Promise<string> {
  await schema();
  const h = cleanHandle(handle);
  if (h.length < 2) throw new Error("Type the Instagram username, like @name.");
  const others = await otherClientHandles(accountId);
  if (!others) throw new Error("Please try again in a minute.");
  if (others.has(h)) throw new Error("That account belongs to another DashPatrol customer, so it can't be suggested.");
  await sql`
    INSERT INTO insights_creators (account_id, handle, source, status) VALUES (${accountId}, ${h}, 'owner', 'added')
    ON CONFLICT (account_id, handle) DO UPDATE SET status = CASE WHEN insights_creators.status = 'dismissed' THEN 'added' ELSE insights_creators.status END, updated_at = now()`;
  return h;
}

// ---------- Meta's sources ----------

const lacks = (e: unknown) => e instanceof MetaApiError && (e.code === 10 || e.code === 200 || e.code === 190 || e.status === 403 || /permission/i.test(e.message));

interface Found {
  handle: string;
  source: "marketplace" | "hashtag" | "owner";
  country?: string | null;
}

async function fromMarketplace(link: FacebookLink): Promise<{ state: SourceState; found: Found[] }> {
  if (link.scopes && !link.scopes.includes(MARKETPLACE_SCOPE)) return { state: "missing", found: [] };
  try {
    const out = await metaCall<{ data?: { username?: string; country?: string }[] }>(`/${link.igUserId}/${MARKETPLACE_EDGE}`, {
      fields: "id,username,country",
      // Smaller creators fit a small brand; engagement filters out inactive accounts. No country is guessed.
      creator_max_followers: "100000",
      creator_min_engaged_accounts: "2000",
      limit: "25",
      access_token: link.token,
    });
    return { state: "ok", found: (out.data ?? []).filter((c) => c.username).map((c) => ({ handle: cleanHandle(String(c.username)), source: "marketplace", country: c.country ? String(c.country) : null })) };
  } catch (e) {
    if (lacks(e) || (e instanceof MetaApiError && e.status === 400 && /unsupported|nonexisting|does not exist/i.test(e.message))) return { state: "missing", found: [] };
    console.warn(`creator marketplace failed: ${(e as Error).message}`);
    return { state: "error", found: [] };
  }
}

async function fromHashtags(accountId: string, link: FacebookLink, topics: string[]): Promise<{ state: SourceState; found: Found[] }> {
  const used = await sql`SELECT tag, at FROM insights_creator_hashtags WHERE account_id = ${accountId}`;
  const wanted = [...new Set(topics.map(hashtagOf).filter((t) => t.length >= 4 && t.length <= 40))].slice(0, HASHTAGS_PER_RUN);
  const allowed = hashtagsAllowed(used.map((u) => ({ tag: String(u.tag), at: new Date(String(u.at)).toISOString() })), wanted);
  if (!allowed.length) return { state: wanted.length ? "ok" : "unknown", found: [] };
  const found: Found[] = [];
  let state: SourceState = "unknown";
  for (const tag of allowed) {
    // Counted before the search (Meta counts the search itself); a tag older than seven days starts a new window.
    await sql`
      INSERT INTO insights_creator_hashtags (account_id, tag) VALUES (${accountId}, ${tag})
      ON CONFLICT (account_id, tag) DO UPDATE SET at = CASE WHEN insights_creator_hashtags.at < now() - interval '7 days' THEN now() ELSE insights_creator_hashtags.at END`;
    try {
      const search = await metaCall<{ data?: { id: string }[] }>("/ig_hashtag_search", { user_id: String(link.igUserId), q: tag, access_token: link.token });
      const id = search.data?.[0]?.id;
      state = "ok";
      if (!id) continue;
      const media = await metaCall<{ data?: { caption?: string }[] }>(`/${id}/top_media`, { user_id: String(link.igUserId), fields: "id,caption,like_count,comments_count", limit: "30", access_token: link.token });
      for (const m of media.data ?? []) for (const h of mentionsIn(String(m.caption ?? ""))) found.push({ handle: h, source: "hashtag" });
    } catch (e) {
      if (lacks(e)) return { state: "missing", found };
      console.warn(`hashtag search failed for account ${accountId}: ${(e as Error).message}`);
      state = "error";
    }
  }
  return { state, found };
}

interface Discovered {
  username: string;
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  media_count?: number;
  media?: { data?: FetchedPost[] };
}

async function discover(link: FacebookLink, handle: string): Promise<Discovered | null> {
  const out = await metaCall<{ business_discovery?: Discovered }>(`/${link.igUserId}`, {
    fields: `business_discovery.username(${handle}){username,name,biography,website,followers_count,media_count,media.limit(12){caption,like_count,comments_count,timestamp}}`,
    access_token: link.token,
  });
  return out.business_discovery ?? null;
}

// ---------- the weekly run ----------

/** Sites with the autopilot on and Instagram connected whose weekly creator search is due. */
export async function accountsDueForCreators(limit: number): Promise<string[]> {
  await schema();
  await facebookSchema();
  const rows = await sql`
    SELECT f.account_id FROM insights_account_facebook f
    JOIN insights_account_autopilot a ON a.account_id = f.account_id
    LEFT JOIN insights_settings s ON s.key = 'creators_run:' || f.account_id::text
    WHERE a.enabled AND f.ig_user_id IS NOT NULL AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** The site's own topics: top searches, product names (its own product pages) and the profile's offer. */
async function siteTopics(accountId: string, profile: Profile): Promise<{ searches: string[]; products: string[] }> {
  const searches: string[] = [];
  const conn = await getConnection(accountId).catch(() => null);
  if (conn?.gscSiteUrl) {
    for (const r of await querySearches28d(conn).catch(() => [])) if (!searches.includes(r.query)) searches.push(r.query);
  }
  for (const k of await readSiteKeywords(accountId).catch(() => [])) if (!searches.includes(k.keyword)) searches.push(k.keyword);
  const brand = profile.brandName?.toLowerCase();
  const host = profile.siteDomain?.replace(/^www\./, "").toLowerCase();
  const products = (await sitePages(accountId).catch(() => []))
    .filter((p) => pageKind(p.url) === "product" && (!host || new URL(p.url).hostname.replace(/^www\./, "").toLowerCase() === host))
    .map((p) => (p.h1 || p.title.split(/\s+[|–—-]\s+/)[0] || "").trim())
    .filter(Boolean)
    .slice(0, 30);
  return { searches: searches.filter((q) => !brand || !q.toLowerCase().includes(brand)).slice(0, 20), products };
}

/** One site's weekly creator search. Returns a line for the log. */
export async function runCreatorFinder(accountId: string): Promise<string> {
  if (isSabbath()) return "rests for the Sabbath";
  await schema();
  if (!(await readAccountAutopilot(accountId)).enabled) return "the autopilot is paused";
  const link = await getFacebook(accountId);
  if (!link?.igUserId) return "Instagram isn't connected";
  const caps: Capabilities = { marketplace: "unknown", hashtags: "unknown", discovery: "unknown" };
  try {
    const profile = await readProfile(accountId);
    const { searches, products } = await siteTopics(accountId, profile);
    const topicWords = siteTopicWords(searches, products, profile.about?.offer, profile.brandName);
    if (!topicWords.size) {
      await saveRun(accountId, caps);
      return "no searches or products of the site's own yet to find creators for";
    }
    const others = await otherClientHandles(accountId);
    if (!others) throw new Error("The list of other customers couldn't be read, so no creators were saved this week.");
    const isOther = await otherClient(profile.siteDomain ?? "");
    const own = (link.igUsername ?? "").toLowerCase();

    const market = await fromMarketplace(link);
    caps.marketplace = market.state;
    const tags = await fromHashtags(accountId, link, [...products, ...searches]);
    caps.hashtags = tags.state;
    const added = await sql`SELECT handle FROM insights_creators WHERE account_id = ${accountId} AND source = 'owner' AND followers IS NULL AND status = 'added'`;
    const known = new Set((await sql`SELECT handle FROM insights_creators WHERE account_id = ${accountId}`).map((r) => String(r.handle)));
    const queue: Found[] = [];
    for (const f of [...added.map((r) => ({ handle: String(r.handle), source: "owner" as const })), ...market.found, ...tags.found]) {
      if (!f.handle || f.handle === own || others.has(f.handle) || queue.some((q) => q.handle === f.handle)) continue;
      if (f.source !== "owner" && known.has(f.handle)) continue;
      queue.push(f);
    }
    let saved = 0;
    // Known from the recorded permissions: no lookups are tried without them.
    if (link.scopes && !link.scopes.includes("instagram_manage_insights")) caps.discovery = "missing";
    for (const f of caps.discovery === "missing" ? [] : queue.slice(0, LOOKUPS_PER_RUN)) {
      let d: Discovered | null;
      try {
        d = await discover(link, f.handle);
        caps.discovery = "ok";
      } catch (e) {
        if (lacks(e)) {
          caps.discovery = "missing";
          break;
        }
        // Not a business or creator account, or gone: Meta won't share its numbers, so it is left out.
        continue;
      }
      if (!d?.followers_count) continue;
      // Another customer's site in the bio link is never suggested either.
      if (d.website && isOther(d.website)) continue;
      const posts = d.media?.data ?? [];
      const captions = posts.map((p) => String(p.caption ?? "")).filter(Boolean);
      const er = engagementRate(posts, d.followers_count);
      const { fit, matched } = topicFit(`${d.biography ?? ""} ${captions.join(" ")}`, topicWords);
      if (f.source !== "owner" && fit === 0) continue;
      const flags = claimFlags(captions);
      const competitor = competitorFlag(captions, products, profile.brandName);
      await sql`
        INSERT INTO insights_creators (account_id, handle, source, name, followers, media_count, engagement, posts_counted, country, fit, score, matched, claim_flags, competitor, status)
        VALUES (${accountId}, ${f.handle}, ${f.source}, ${d.name ?? null}, ${d.followers_count}, ${d.media_count ?? null}, ${er?.rate ?? null}, ${er?.posts ?? null},
          ${f.country ?? null}, ${fit}, ${creatorScore(fit, er?.rate ?? null)}, ${matched.join("\n")}, ${flags.join("\n")}, ${competitor}, ${f.source === "owner" ? "added" : "new"})
        ON CONFLICT (account_id, handle) DO UPDATE SET name = EXCLUDED.name, followers = EXCLUDED.followers, media_count = EXCLUDED.media_count,
          engagement = EXCLUDED.engagement, posts_counted = EXCLUDED.posts_counted, country = COALESCE(EXCLUDED.country, insights_creators.country),
          fit = EXCLUDED.fit, score = EXCLUDED.score, matched = EXCLUDED.matched, claim_flags = EXCLUDED.claim_flags, competitor = EXCLUDED.competitor, updated_at = now()`;
      saved++;
    }
    await saveRun(accountId, caps);
    const working = [caps.marketplace, caps.hashtags, caps.discovery].some((s) => s === "ok");
    if (caps.marketplace === "error" || caps.hashtags === "error") void report("creators", false, "A creator source failed this week; it tries again next week.");
    else if (working) void report("creators", true);
    else if (caps.discovery === "missing") void report("creators", false, "Permission: business discovery isn't allowed for this connection.");
    return `${saved} creators looked up`;
  } catch (e) {
    await saveRun(accountId, caps).catch(() => undefined);
    void report("creators", false, (e as Error).message);
    throw e;
  }
}

// ---------- the owner's message draft ----------

const PARTNERSHIP_LINE = "If you post about it, please turn on the paid partnership label.";
const NO_CLAIMS_LINE = "Please don't say it cures, treats or prevents anything, and don't promise results.";

/** The full message the owner copies: the personal part, the paid partnership ask, the approved wording and the link. */
export function composeCreatorMessage(message: string, brief: string, link: string | null): string {
  return [message, PARTNERSHIP_LINE, `Approved wording: ${brief}`, NO_CLAIMS_LINE, link ? `Your link: ${link}` : ""].filter(Boolean).join("\n\n");
}

/** Whether another draft fits this week. */
export const canDraft = (draftedThisWeek: number) => draftedThisWeek < CREATOR_DRAFT_CAP;

/** Writes the message draft for one creator (the owner's click), within five a week. The owner sends it themselves. */
export async function draftCreatorMessage(accountId: string, handle: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await schema();
  const h = cleanHandle(handle);
  const [row] = await sql`SELECT * FROM insights_creators WHERE account_id = ${accountId} AND handle = ${h}`;
  if (!row || row.status === "dismissed") return { ok: false, status: 404, error: "That creator isn't on the list anymore." };
  if (row.followers == null) return { ok: false, status: 409, error: "Their public numbers haven't been looked up yet. Try after the next weekly run." };
  const profile = await readProfile(accountId);
  const health = healthRulesApply(profile);
  if (health && list(row.claim_flags).length) return { ok: false, status: 409, error: "Their recent posts make health claims, so a health site doesn't approach them." };
  const offer = profile.about?.offer?.trim() || siteBrief(profile).sells;
  if (claimProblem(offer, health)) return { ok: false, status: 409, error: "The offer in your business profile has wording the claim guard flags. Change it in Settings first." };
  const base = aiProvider(await readPlatformSettings());
  if (!base) return { ok: false, status: 400, error: "An AI key is needed to write the message." };
  // One of this week's five drafts, taken in one statement that refuses at the cap.
  const stamp = new Date().toISOString();
  const [slot] = await sql`
    INSERT INTO insights_creator_drafts (account_id, times) VALUES (${accountId}, ARRAY[${stamp}::timestamptz])
    ON CONFLICT (account_id) DO UPDATE
      SET times = array_append(ARRAY(SELECT t FROM unnest(insights_creator_drafts.times) t WHERE t > now() - interval '7 days'), ${stamp}::timestamptz)
      WHERE (SELECT count(*) FROM unnest(insights_creator_drafts.times) t WHERE t > now() - interval '7 days') < ${CREATOR_DRAFT_CAP}
    RETURNING account_id`;
  if (!slot) return { ok: false, status: 429, error: `${CREATOR_DRAFT_CAP} messages were drafted in the last seven days, the most allowed. More next week.` };
  try {
    const ai = { ...base, site: siteBrief(profile) };
    const creatorText = `${row.name ?? ""}. Topics they post about: ${list(row.matched).join(", ")}`;
    const raw = await writeCreatorMessage(ai, { handle: h, creatorText, offer, audience: profile.about?.audience ?? "", brand: profile.brandName, site: profile.siteDomain ?? "this site", health });
    const keep = [profile.brandName, profile.siteDomain, `@${h}`, h].filter((x): x is string => Boolean(x && x.trim()));
    const msg = cleanPost(raw.message, keep, 700, health);
    const brief = cleanPost(raw.brief, keep, 300, health);
    const problem = msg.problem || brief.problem;
    const home = profile.siteDomain ? `https://${profile.siteDomain}/` : null;
    const text = composeCreatorMessage(noDashes(msg.text), noDashes(brief.text), home ? creatorLink(home, h) : null);
    let checked: "ai" | "owner" = "owner";
    let reason: string | null = problem;
    let rejected = Boolean(problem);
    if (!problem) {
      const verdict = await secondCheck(ai, { what: "a first message from a business owner to an Instagram creator about a paid post", source: `What the business offers: ${offer}`, text, health });
      if (verdict && !verdict.ok) {
        rejected = true;
        reason = `The second AI turned it down: ${verdict.why || "no reason given."}`;
      }
      else if (verdict) checked = "ai";
      else reason = "No second AI was free to check it. Read it carefully before you send it.";
    }
    if (rejected) {
      // Not usable: the week's draft is given back.
      await sql`UPDATE insights_creator_drafts SET times = array_remove(times, ${stamp}::timestamptz) WHERE account_id = ${accountId}`;
      await sql`UPDATE insights_creators SET message_reason = ${reason}, updated_at = now() WHERE account_id = ${accountId} AND handle = ${h}`;
      return { ok: false, status: 422, error: `The message didn't pass the checks: ${reason}` };
    }
    await sql`
      UPDATE insights_creators SET status = 'drafted', message = ${text}, message_checked = ${checked}, message_reason = ${reason}, drafted_at = now(), updated_at = now()
      WHERE account_id = ${accountId} AND handle = ${h}`;
    return { ok: true };
  } catch (e) {
    await sql`UPDATE insights_creator_drafts SET times = array_remove(times, ${stamp}::timestamptz) WHERE account_id = ${accountId}`.catch(() => undefined);
    throw e;
  }
}
