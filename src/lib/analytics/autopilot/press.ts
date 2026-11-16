import crypto from "node:crypto";
import { ensureSchema, sql } from "../db";
import { toText } from "../site-crawl";
import { topicTerms } from "../landing";
import { isPaidPlacement, NOT_PROSPECTS, pickTopics } from "./backlinks";
import { readCapped, safeFetch } from "./broken-links";
import { scanClaims } from "./claims";
import { isSabbath } from "./sabbath";
import { isStore, plainWords } from "./store-audit";
import { accountsDueWeekly, readRunNote, runWeekly, saveRunMarker, type RunOutcome } from "./weekly-run";
import type { NewsResult, SerpResult } from "./serp";
import type { Row } from "../db";
import { byDeadline } from "./store-audit";
import { asData } from "./writer";

/**
 * The Outreach agents: getting the owner's business into the media, the honest way.
 * - Journalists (status part "press"): reporters and writers who recently published on the site's own topics, found
 *   with the same search provider as the backlink finder (its news search). Only what the article page shows is kept:
 *   the outlet, the article title and address, its date, and the author's name as printed. A contact is kept only when
 *   it is printed: the author's page on the outlet, an email on the article, or the outlet's published email
 *   (contact-finder.ts). Nothing is guessed. A short personal pitch offering something useful (an expert quote, or a
 *   sample for a store) is written for at most five a week, passes the claim guard and a second AI, and the owner sends
 *   it. Nothing is ever sent from here.
 * - Paid opportunities (also "press"): newsletter, podcast and sponsored article placements on the site's topics, from
 *   pages that say they sell them. A price only when the page states one. Nothing is bought without the owner, within
 *   the spending cap, and paid placements are never backlinks (they must be labeled sponsored, links rel="sponsored").
 * - Media requests (status part "media-requests"): public requests where journalists ask for sources, with the deadline
 *   only when shown, and a short answer from the site's own page when the owner asks for one.
 * Other customers' sites are never listed. Each site uses only its own data.
 */

// ---------- pure parts (tested) ----------

export type JournalistStatus = "new" | "pitched" | "replied" | "covered" | "dismissed";

export interface Pitch {
  subject: string;
  body: string;
  offer: "quote" | "sample";
  at: string;
}

export interface Journalist {
  id: string;
  /** The author's name exactly as printed on the article. */
  name: string;
  outlet: string;
  outletDomain: string;
  articleTitle: string;
  articleUrl: string;
  /** The article's date as the page or the search shows it, or null. */
  date: string | null;
  topic: string;
  /** The author's page on the outlet, when the article links to it. */
  contactPage: string | null;
  /** An email printed by the article next to the byline, or the outlet's published email (labeled as such). */
  email: string | null;
  emailIsOutlets: boolean;
  status: JournalistStatus;
  statusAt?: string;
  pitch?: Pitch;
  /** Why the last pitch couldn't be written, in plain words. */
  pitchNote?: string | null;
  /** A permanent note (the checks turned this pitch down) stops automatic drafts; a temporary one is retried next week. */
  pitchNoteKind?: "permanent" | "temporary" | null;
  pitchNoteAt?: string | null;
  foundAt: string;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Names that are not a person: a desk, a team, a newsroom or the outlet itself. */
const NOT_A_PERSON = /\b(staff|editor(?:s|ial)?|team|desk|newsroom|admin|contributor|guest|press|news|media|writers?|reporters?|bureau|wire|associated|reuters|partner|sponsored|brand)\b/i;

/** A plausible person's name as printed: two to four words of letters, not a desk or the outlet. */
export function isPersonName(name: string, outlet = ""): boolean {
  const n = name.trim();
  if (n.length < 4 || n.length > 60 || NOT_A_PERSON.test(n) || /[@/\d]|https?:/i.test(n)) return false;
  if (outlet && n.toLowerCase() === outlet.toLowerCase()) return false;
  const words = n.split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[\p{Lu}][\p{L}'.’]*$/u.test(w) || /^(?:de|da|van|von|der|la|le|del|di|bin|al)$/i.test(w));
}

/** The author's name as printed on an article: its structured data, its author meta tag, or its byline. Null otherwise. */
export function bylineOf(html: string, outlet = ""): string | null {
  const cands: string[] = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const a of m[1].matchAll(/"author"\s*:\s*(\[[\s\S]*?\]|\{[\s\S]*?\}|"[^"]*")/g)) {
      const name = /"name"\s*:\s*"([^"]+)"/.exec(a[1])?.[1] ?? (/^"([^"]*)"$/.exec(a[1])?.[1] ?? "");
      if (name) cands.push(decode(name));
    }
  }
  const meta = /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i.exec(html)?.[1];
  if (meta) cands.push(decode(meta));
  const rel = /<a\b[^>]*rel=["'][^"']*\bauthor\b[^"']*["'][^>]*>([\s\S]{1,120}?)<\/a>/i.exec(html)?.[1];
  if (rel) cands.push(decode(toText(rel)));
  const by = /class=["'][^"']*\b(?:byline|author-name|author__name|c-byline__author)\b[^"']*["'][^>]*>([\s\S]{1,200}?)<\//i.exec(html)?.[1];
  if (by) cands.push(decode(toText(by)).replace(/^by\s+/i, ""));
  return cands.find((c) => isPersonName(c, outlet)) ?? null;
}

/** The article's published date from its own page (structured data or meta tag), as an ISO day. Null otherwise. */
export function publishedOf(html: string): string | null {
  const raw =
    /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The author's own page on the outlet, when the article links to it (rel=author, or a link with their name). */
export function contactPageOf(html: string, articleUrl: string, author: string): string | null {
  const host = new URL(articleUrl).hostname.replace(/^www\./, "");
  const links = [...html.matchAll(/<a\b([^>]*)href=["']([^"'#]+)["']([^>]*)>([\s\S]{0,160}?)<\/a>/gi)];
  for (const m of links) {
    const attrs = `${m[1]} ${m[3]}`;
    const text = decode(toText(m[4]));
    if (!/\brel=["'][^"']*\bauthor\b/i.test(attrs) && text.toLowerCase() !== author.toLowerCase()) continue;
    try {
      const u = new URL(decode(m[2]), articleUrl);
      if (/^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, "") === host && /\/(?:authors?|people|staff|contributors?|profile|writers?|team)\//i.test(u.pathname)) return u.href;
    } catch {
      /* skipped */
    }
  }
  return null;
}

/**
 * An email the article prints for its author: a mailto link inside the byline element, or a mailto link marked
 * rel="author". Anywhere else on the page (a newsroom footer, a tips line) it isn't theirs: null. Never a guessed one.
 */
export function emailNearByline(html: string, author: string): string | null {
  const blocks: string[] = [];
  for (const m of html.matchAll(/<(p|div|span|section|address|li|header)\b[^>]*class=["'][^"']*\b(?:byline|author|article-author|post-author|c-byline)[\w-]*\b[^"']*["'][^>]*>([\s\S]{0,1200}?)<\/\1>/gi)) blocks.push(m[2]);
  for (const m of html.matchAll(/<a\b[^>]*\brel=["'][^"']*\bauthor\b[^"']*["'][^>]*>/gi)) blocks.push(m[0]);
  for (const b of blocks) {
    if (!b.toLowerCase().includes(author.toLowerCase()) && !/\brel=["'][^"']*\bauthor\b/i.test(b)) continue;
    const m = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(b);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * An address may be shown as "the outlet's published email" only when it is on the outlet's own domain (or a
 * subdomain), never on another DashPatrol customer's domain.
 */
export function outletEmailOk(email: string | null, outletDomain: string, isOther: (d: string) => boolean): boolean {
  if (!email) return false;
  const host = email.split("@")[1]?.toLowerCase() ?? "";
  const d = bare(outletDomain);
  return Boolean(host) && (host === d || host.endsWith(`.${d}`)) && !isOther(host);
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

/**
 * The search's date turned into an absolute day when that is exact enough: "3 days ago" or "2 weeks ago" from now, a
 * written date with its year as it is. Anything vaguer ("a month ago", no year) is left out, never stored as relative.
 */
export function absoluteDate(text: string | null, now = Date.now()): string | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  const rel = /^(\d+|an?|one)\s+(minute|hour|day|week)s?\s+ago$/.exec(t);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : 1;
    const ms = { minute: 6e4, hour: 36e5, day: 864e5, week: 7 * 864e5 }[rel[2] as "minute" | "hour" | "day" | "week"];
    return new Date(now - n * ms).toISOString().slice(0, 10);
  }
  if (/ago|yesterday|today/.test(t)) return t === "yesterday" ? new Date(now - 864e5).toISOString().slice(0, 10) : t === "today" ? new Date(now).toISOString().slice(0, 10) : null;
  const m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(t) ?? null;
  if (m && MONTHS.includes(m[1])) return new Date(Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2]))).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return iso ? iso[1] : null;
}

export const journalistId = (name: string, outletDomain: string) => crypto.createHash("sha1").update(`${name.toLowerCase()}|${outletDomain}`).digest("hex").slice(0, 16);

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * A journalist from one news result and its fetched article page: only when the page prints a person's name as the
 * author. The site's own pages, other customers' sites and social sites are never listed.
 */
export function journalistFrom(n: NewsResult, html: string, topic: string, ourDomain: string, isOther: (d: string) => boolean): Journalist | null {
  const domain = bare(n.domain || new URL(n.link).hostname);
  const ours = bare(ourDomain);
  if (!domain || domain === ours || domain.endsWith(`.${ours}`) || isOther(domain) || NOT_PROSPECTS.test(domain)) return null;
  const outlet = n.source || domain;
  const name = bylineOf(html, outlet);
  if (!name) return null;
  const titleOnPage = decode(toText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")) || n.title;
  const email = emailNearByline(html, name);
  return {
    id: journalistId(name, domain),
    name,
    outlet,
    outletDomain: domain,
    articleTitle: (n.title || titleOnPage).slice(0, 200),
    articleUrl: n.link,
    // Never a relative date: the page's own date, or the search's turned into a day, or none.
    date: publishedOf(html) ?? absoluteDate(n.date),
    topic,
    contactPage: contactPageOf(html, n.link, name),
    email,
    emailIsOutlets: false,
    status: "new",
    foundAt: new Date().toISOString(),
  };
}

/** New pitch drafts a week, and AI draft attempts a day (passed or not). */
export const PITCH_WEEKLY_CAP = 5;
export const ATTEMPT_DAILY_CAP = 10;

/** Drafts left this week: at most five checked drafts (pitches and source answers) in the last seven days. */
export const draftRoom = (drafts: string[], now = Date.now(), cap = PITCH_WEEKLY_CAP) => Math.max(0, cap - drafts.filter((t) => now - Date.parse(t) < 7 * 864e5).length);
export const attemptRoom = (attempts: string[], now = Date.now()) => Math.max(0, ATTEMPT_DAILY_CAP - attempts.filter((t) => now - Date.parse(t) < 864e5).length);

/** The pitch the owner copies: the greeting with the printed name, the checked text, and the business's sign off. */
export function composePitch(name: string, body: string, brand: string | null, domain: string): string {
  const first = name.split(/\s+/)[0];
  return plainWords(`Hi ${first},\n\n${body.trim()}\n\nBest regards,\n${brand ?? domain}\nhttps://${domain}`).replace(/ ?\n ?/g, "\n");
}

// ---------- paid opportunities ----------

/** A page that sells placements: the same test the backlink finder uses to keep them off its list. */
export { isPaidPlacement };

export type PaidType = "newsletter" | "podcast" | "sponsored article" | "media kit" | "advertising";

export function paidType(text: string): PaidType {
  if (/newsletter|subscribers|inbox/i.test(text)) return "newsletter";
  if (/podcast|episode|listeners|host read/i.test(text)) return "podcast";
  if (/sponsored (?:post|content|article)|advertorial|guest post/i.test(text)) return "sponsored article";
  if (/media[ -]?kit|rate ?card/i.test(text)) return "media kit";
  return "advertising";
}

/**
 * A price the page states for a placement, exactly as written ("$450 per issue"), or null. Never estimated: a page
 * with no amount of money gives no price.
 */
export function statedPrice(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  const m = /(?:(?:US)?\$|€|£|USD\s?|EUR\s?|GBP\s?)\s?\d{1,3}(?:[,.]\d{3})*(?:\.\d{2})?(?:\s?[kK])?(?:\s?(?:per|\/|a|an)\s?(?:issue|send|week|month|episode|post|placement|spot|article|newsletter|insertion|mention))?/.exec(t);
  if (!m) return null;
  // Only an amount next to words about a placement: not a product or subscription price elsewhere on the page.
  const around = t.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
  if (/subscri|membership|premium plan|per year for|annual plan|join for|members?\b/i.test(around)) return null;
  return /\bsponsor(?:s|ship|ships|ed)?\b|\bplacements?\b|\bad (?:slot|spot|placement)s?\b|\brates?\b|per (?:issue|episode|send|insertion)|newsletter ads?\b|advertis/i.test(around) ? m[0].trim() : null;
}

export interface PaidOpportunity {
  url: string;
  outlet: string;
  domain: string;
  type: PaidType;
  title: string;
  /** Only when the page states it. */
  price: string | null;
  topic: string;
  foundAt: string;
  dismissed?: boolean;
}

/** What the owner reads with every paid placement. */
export const PAID_NOTE =
  "Paid placements are advertising, not backlinks. They must be labeled sponsored, and any link in them must carry rel=\"sponsored\", as Google requires. Nothing is bought without your approval, and only within your spending cap.";

// ---------- media requests ----------

export interface MediaRequest {
  url: string;
  title: string;
  snippet: string;
  platform: string;
  /** Only when the request shows one. */
  deadline: string | null;
  topic: string;
  foundAt: string;
  answer?: { text: string; page: string; at: string };
  answerNote?: string;
  dismissed?: boolean;
}

/** Places where journalists post requests for sources; the owner signs up there. */
export const SOURCE_PLATFORMS: { name: string; host: string; url: string }[] = [
  { name: "Qwoted", host: "qwoted.com", url: "https://www.qwoted.com/" },
  { name: "Featured", host: "featured.com", url: "https://featured.com/" },
  { name: "SourceBottle", host: "sourcebottle.com", url: "https://www.sourcebottle.com/" },
  { name: "Help a B2B Writer", host: "helpab2bwriter.com", url: "https://helpab2bwriter.com/" },
];

const REQUEST = /\b(?:looking for|seeking|searching for|need(?:s|ed)?|request(?:ing)?|call ?out for|wants?|wanted)\b[^.]{0,60}\b(?:sources?|experts?|quotes?|comments?|insights?|interviews?|contributors?|tips|stories)\b|#?journorequest|source request|\bquery:/i;

/** The deadline as the request shows it ("Deadline: Nov 20"), or null. */
export function deadlineOf(text: string): string | null {
  const m = /\b(?:deadline|due|closes?|closing)\s*(?:date|by|on)?\s*[:\-]?\s*([A-Z][a-z]{2,8}\.? \d{1,2}(?:,? \d{4})?|\d{1,2} [A-Z][a-z]{2,8}(?: \d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|today|tomorrow)/i.exec(text);
  return m ? m[1] : null;
}

/** A request for sources from one search result, or null when it doesn't read as one. */
export function requestFrom(r: SerpResult, topic: string, ourDomain: string, isOther: (d: string) => boolean): MediaRequest | null {
  const domain = bare(r.domain);
  const ours = bare(ourDomain);
  if (!domain || domain === ours || domain.endsWith(`.${ours}`) || isOther(domain)) return null;
  const text = `${r.title} ${r.snippet}`;
  if (!REQUEST.test(text)) return null;
  const platform = SOURCE_PLATFORMS.find((p) => domain === p.host || domain.endsWith(`.${p.host}`))?.name ?? domain;
  return { url: r.link, title: r.title.slice(0, 200), snippet: r.snippet.slice(0, 400), platform, deadline: deadlineOf(text), topic, foundAt: new Date().toISOString() };
}

// ---------- storage: one row per item, the owner's fields apart ----------

export type ItemKind = "journalist" | "request" | "paid";
/** A tagged SQL runner (the database, or a stand in for tests). */
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

/** Fields only the owner sets. The agents never write them, so an owner's change can't be overwritten. */
export const OWNER_FIELDS = ["status", "statusAt", "dismissed"] as const;

const withoutOwnerFields = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !(OWNER_FIELDS as readonly string[]).includes(k)));

/** An item as shown: the agent's data, with the owner's fields on top (the owner always wins). */
export function mergeItem<T>(data: Record<string, unknown>, owner: Record<string, unknown> | null): T {
  const mine = Object.fromEntries(Object.entries(owner ?? {}).filter(([k]) => (OWNER_FIELDS as readonly string[]).includes(k)));
  return { status: "new", ...withoutOwnerFields(data), ...mine } as T;
}

let tablesReady: Promise<void> | null = null;
function tables(): Promise<void> {
  tablesReady ??= (async () => {
    await ensureSchema();
    await sql`CREATE TABLE IF NOT EXISTS insights_press_items (
      account_id bigint NOT NULL REFERENCES insights_accounts (id) ON DELETE CASCADE,
      kind text NOT NULL,
      item_id text NOT NULL,
      data jsonb NOT NULL,
      owner jsonb NOT NULL DEFAULT '{}'::jsonb,
      found_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, kind, item_id)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_press_drafts (
      account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
      drafts timestamptz[] NOT NULL DEFAULT '{}',
      attempts timestamptz[] NOT NULL DEFAULT '{}'
    )`;
  })().catch((e) => {
    tablesReady = null;
    throw e;
  });
  return tablesReady;
}

export const itemId = (key: string) => crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);

/** A new find. One already stored keeps its row as it is (the owner's fields, a pitch, an answer). */
export async function addItem(accountId: string, kind: ItemKind, id: string, data: Record<string, unknown>, q: Sql = sql): Promise<void> {
  await q`
    INSERT INTO insights_press_items (account_id, kind, item_id, data) VALUES (${accountId}, ${kind}, ${id}, ${JSON.stringify(withoutOwnerFields(data))}::jsonb)
    ON CONFLICT (account_id, kind, item_id) DO NOTHING`;
}

/**
 * The agent's fields on one item, merged into the stored row in one statement (never the owner's fields). With
 * `unlessSet`, only when that field isn't there yet: two drafts at once can't both land. True when it was written.
 */
export async function patchItem(accountId: string, kind: ItemKind, id: string, patch: Record<string, unknown>, unlessSet: string | null = null, q: Sql = sql): Promise<boolean> {
  const rows = await q`
    UPDATE insights_press_items SET data = data || ${JSON.stringify(withoutOwnerFields(patch))}::jsonb
    WHERE account_id = ${accountId} AND kind = ${kind} AND item_id = ${id} AND (${unlessSet}::text IS NULL OR data ->> ${unlessSet}::text IS NULL)
    RETURNING item_id`;
  return rows.length > 0;
}

/** The owner's fields on one item, merged in one statement. */
export async function setOwnerFields(accountId: string, kind: ItemKind, id: string, patch: Record<string, unknown>, q: Sql = sql): Promise<void> {
  const mine = Object.fromEntries(Object.entries(patch).filter(([k]) => (OWNER_FIELDS as readonly string[]).includes(k)));
  await q`
    UPDATE insights_press_items SET owner = owner || ${JSON.stringify(mine)}::jsonb
    WHERE account_id = ${accountId} AND kind = ${kind} AND item_id = ${id}`;
}

const jsonOf = (v: unknown): Record<string, unknown> => (typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>));

export async function readItems<T>(accountId: string, kind: ItemKind): Promise<T[]> {
  await tables();
  const rows = await sql`SELECT data, owner FROM insights_press_items WHERE account_id = ${accountId} AND kind = ${kind} ORDER BY found_at DESC`;
  return rows.map((r) => mergeItem<T>(jsonOf(r.data), jsonOf(r.owner)));
}

async function readItem<T>(accountId: string, kind: ItemKind, id: string): Promise<T | null> {
  await tables();
  const [r] = await sql`SELECT data, owner FROM insights_press_items WHERE account_id = ${accountId} AND kind = ${kind} AND item_id = ${id}`;
  return r ? mergeItem<T>(jsonOf(r.data), jsonOf(r.owner)) : null;
}

// ---------- draft slots: taken in one statement, given back when a draft fails ----------

/**
 * One of the week's five drafts and one of the day's ten attempts, taken together in a single statement that refuses
 * when either cap is reached, so two drafts at once can never pass the cap. The stamp to give back, or null.
 */
export async function takeDraftSlot(accountId: string, q: Sql = sql): Promise<string | null> {
  // Microseconds added so two drafts in the same millisecond never share a stamp (giving one back removes only its own).
  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 23)}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}Z`;
  const rows = await q`
    INSERT INTO insights_press_drafts (account_id, drafts, attempts) VALUES (${accountId}, ARRAY[${stamp}::timestamptz], ARRAY[${stamp}::timestamptz])
    ON CONFLICT (account_id) DO UPDATE SET
      drafts = array_append(ARRAY(SELECT t FROM unnest(insights_press_drafts.drafts) t WHERE t > now() - interval '7 days'), ${stamp}::timestamptz),
      attempts = array_append(ARRAY(SELECT t FROM unnest(insights_press_drafts.attempts) t WHERE t > now() - interval '1 day'), ${stamp}::timestamptz)
    WHERE (SELECT count(*) FROM unnest(insights_press_drafts.drafts) t WHERE t > now() - interval '7 days') < ${PITCH_WEEKLY_CAP}
      AND (SELECT count(*) FROM unnest(insights_press_drafts.attempts) t WHERE t > now() - interval '1 day') < ${ATTEMPT_DAILY_CAP}
    RETURNING account_id`;
  return rows.length ? stamp : null;
}

/** A draft that didn't pass gives its week slot back; the attempt still counts for the day. */
export async function releaseDraftSlot(accountId: string, stamp: string, q: Sql = sql): Promise<void> {
  await q`UPDATE insights_press_drafts SET drafts = array_remove(drafts, ${stamp}::timestamptz) WHERE account_id = ${accountId}`;
}

async function slotCounts(accountId: string): Promise<{ drafts: number; attempts: number }> {
  await tables();
  const [r] = await sql`
    SELECT (SELECT count(*) FROM unnest(drafts) t WHERE t > now() - interval '7 days') AS d,
           (SELECT count(*) FROM unnest(attempts) t WHERE t > now() - interval '1 day') AS a
    FROM insights_press_drafts WHERE account_id = ${accountId}`;
  return { drafts: Number(r?.d ?? 0), attempts: Number(r?.a ?? 0) };
}

const capMessage = async (accountId: string) =>
  (await slotCounts(accountId)).drafts >= PITCH_WEEKLY_CAP
    ? `${PITCH_WEEKLY_CAP} drafts were written in the last seven days, the most allowed. More next week.`
    : `${ATTEMPT_DAILY_CAP} drafts were tried today, the most allowed. Try again tomorrow.`;

const PRESS_RUN = "press_run";
const REQUEST_RUN = "media_requests_run";
const pressMetaKey = (a: string) => `press_meta:${a}`;
const requestMetaKey = (a: string) => `media_requests_meta:${a}`;

async function readMeta<T>(key: string): Promise<T | null> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key}`.catch(() => [] as Row[]);
  try {
    return row?.value ? (JSON.parse(String(row.value)) as T) : null;
  } catch {
    return null;
  }
}
async function writeMeta(key: string, v: unknown): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key}, ${JSON.stringify(v)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const accountsDueForPress = (limit: number) => tables().then(() => accountsDueWeekly(PRESS_RUN, limit));
export const accountsDueForMediaRequests = (limit: number) => tables().then(() => accountsDueWeekly(REQUEST_RUN, limit));

// ---------- the site's context ----------

interface Context {
  accountId: string;
  domain: string;
  brand: string | null;
  offer: string;
  expertise: string;
  health: boolean;
  store: boolean;
  topics: string[];
}

async function context(accountId: string): Promise<Context | { skip: string }> {
  const [{ readProfile, healthRulesApply, siteBrief }, { siteTopics }] = await Promise.all([import("../profile"), import("../creators")]);
  const profile = await readProfile(accountId);
  if (!profile.siteDomain) return { skip: "no website address yet" };
  const { searches, products } = await siteTopics(accountId, profile);
  const a = profile.about;
  const offer = a?.offer?.trim() || siteBrief(profile).sells;
  const picked = pickTopics(searches.map((k, i) => ({ keyword: k, source: i < 5 ? 0 : 1 })), a ? [a.offer, a.audience].filter(Boolean).join(" ") : null);
  const brandWords = new Set((profile.brandName ?? "").toLowerCase().split(/\s+/));
  const product = products[0]
    ?.toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !brandWords.has(w) && !/\d/.test(w))
    .slice(0, 3)
    .join(" ");
  const topics = [...new Set([...picked, ...(product ? [product] : [])])].slice(0, 3);
  return {
    accountId,
    domain: profile.siteDomain,
    brand: profile.brandName,
    offer,
    expertise: a?.difference?.trim() ?? "",
    health: healthRulesApply(profile),
    store: isStore({ shopify: profile.platform === "shopify", businessType: profile.businessType, productPages: products.length }),
    topics,
  };
}

/** Reads a public page (every hop must be public), capped. Its text is only ever data. */
async function readPage(url: string, timeoutMs: number): Promise<string> {
  const res = await safeFetch(url, "GET", timeoutMs).catch(() => null);
  if (!res || res === "unresolved" || !res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
    if (res && res !== "unresolved") await res.body?.cancel().catch(() => undefined);
    return "";
  }
  return readCapped(res, 800_000).catch(() => "");
}

// ---------- pitches ----------

type DraftResult = { ok: true } | { ok: false; status: number; error: string };
type Made = { pitch: Pitch } | { note: string; permanent: boolean };

/**
 * Writes and checks a pitch: the claim guard on every sentence, then a second AI from another service against the
 * business's own offer. Without a second AI no pitch is written. Public text (the outlet, the article title) reaches
 * both AIs only inside marked data blocks.
 */
async function makePitch(ctx: Context, j: Journalist): Promise<Made> {
  const [{ aiProvider, readPlatformSettings }, { writePressPitch, secondCheck }, { cleanPost }, { readProfile, siteBrief }] = await Promise.all([
    import("./settings"),
    import("./writer"),
    import("../social-agent"),
    import("../profile"),
  ]);
  const base = aiProvider(await readPlatformSettings());
  if (!base) return { note: "An AI key is needed to write pitches. It tries again next week.", permanent: false };
  const ai = { ...base, site: siteBrief(await readProfile(ctx.accountId)) };
  const offerKind = ctx.store ? "sample" : "quote";
  const raw = await writePressPitch(ai, {
    name: j.name,
    outlet: j.outlet,
    articleTitle: j.articleTitle,
    topic: j.topic,
    offer: ctx.offer,
    expertise: ctx.expertise,
    brand: ctx.brand,
    site: ctx.domain,
    health: ctx.health,
    offerKind,
  });
  const keep = [ctx.brand, ctx.domain, j.name, j.outlet].filter((x): x is string => Boolean(x && x.trim()));
  const body = cleanPost(raw.body, keep, 900, ctx.health);
  const subject = cleanPost(raw.subject, keep, 120, ctx.health);
  const problem = pitchProblem(`${subject.text}\n${body.text}`, ctx.health) ?? body.problem ?? subject.problem;
  if (problem || !body.text || !subject.text) return { note: problem ?? "The checks removed too much of it.", permanent: true };
  const text = composePitch(j.name, body.text, ctx.brand, ctx.domain);
  const verdict = await secondCheck(ai, {
    what: `a first email from a business owner to a journalist, offering ${offerKind === "sample" ? "a product sample to review" : "an expert quote"}`,
    source: `What the business offers: ${ctx.offer}\n${ctx.expertise ? `What it knows well: ${ctx.expertise}\n` : ""}The journalist's outlet and article title:\n${asData(`${j.outlet}: ${j.articleTitle}`, 400)}`,
    text: `${subject.text}\n\n${text}`,
    health: ctx.health,
  });
  if (!verdict) return { note: "No second AI from another service was free to check it, so no pitch was written. It tries again next week.", permanent: false };
  if (!verdict.ok) return { note: `The second AI turned it down: ${plainWords(verdict.why || "no reason given")}`, permanent: true };
  return { pitch: { subject: plainWords(subject.text), body: text, offer: offerKind, at: new Date().toISOString() } };
}

/**
 * The claim guard on a pitch: no wording that reads as a medical or unprovable claim (every site), nothing that cures,
 * treats, heals or prevents on a health site, no sources nobody can check, no promised results.
 */
export function pitchProblem(text: string, health: boolean): string | null {
  const flag = scanClaims(text)[0];
  if (flag) return `The claim guard stopped it: "${flag.phrase}".`;
  if (health && /\b(?:cures?|cured|treats?|treatment|heals?|healing|prevents?|diagnos\w*|dose|dosage|remedy|disease)\b/i.test(text)) return "It talks about curing, treating or dosing, which a health business never pitches.";
  if (/\b(?:studies|research)\s+(?:show|shows|prove|proves|found)\b|\bclinically\b|\bguarantee[sd]?\b|\bproven\b/i.test(text)) return "It makes a claim nobody can check.";
  return null;
}

/**
 * Whether the weekly run may draft this journalist's pitch by itself: a new one with no pitch, and no note, or only a
 * temporary note from a week or more ago (no second AI then, a limit, a time out). A permanent note (the checks turned
 * it down) leaves it to the owner.
 */
export function autoDraftable(j: Pick<Journalist, "status" | "pitch" | "pitchNote" | "pitchNoteKind" | "pitchNoteAt">, now = Date.now()): boolean {
  if (j.status !== "new" || j.pitch) return false;
  if (!j.pitchNote) return true;
  if (j.pitchNoteKind === "permanent") return false;
  return !j.pitchNoteAt || now - Date.parse(j.pitchNoteAt) >= 7 * 864e5;
}

const note = (text: string, permanent: boolean) => ({ pitchNote: text, pitchNoteKind: permanent ? "permanent" : "temporary", pitchNoteAt: new Date().toISOString() });

/**
 * The owner's Draft pitch click (and the weekly run, with its deadline): one slot of the week's five and the day's ten
 * attempts, taken atomically and given back when no pitch is saved.
 */
export async function draftPitch(accountId: string, id: string, deadline: number | null = null): Promise<DraftResult> {
  const j = await readItem<Journalist>(accountId, "journalist", id);
  if (!j || j.status === "dismissed") return { ok: false, status: 404, error: "That journalist isn't on the list anymore." };
  if (j.pitch) return { ok: true };
  const ctx = await context(accountId);
  if ("skip" in ctx) return { ok: false, status: 409, error: "Add your website address first." };
  const stamp = await takeDraftSlot(accountId);
  if (!stamp) return { ok: false, status: 429, error: await capMessage(accountId) };
  let saved = false;
  try {
    if (!j.email && !j.contactPage) {
      // Only an address the outlet itself publishes, on its own domain, and never another customer's.
      const [{ findContactEmail }, { otherClient }] = await Promise.all([import("./contact-finder"), import("./clients")]);
      const isOther = await otherClient(ctx.domain);
      const found = await findContactEmail(j.articleUrl, j.outletDomain).catch(() => null);
      if (outletEmailOk(found, j.outletDomain, isOther)) await patchItem(accountId, "journalist", id, { email: found, emailIsOutlets: true }, "email");
    }
    const made = deadline === null ? await makePitch(ctx, j) : await byDeadline(makePitch(ctx, j), deadline);
    if (!("pitch" in made)) {
      await patchItem(accountId, "journalist", id, note(made.note, made.permanent));
      return { ok: false, status: 422, error: made.note };
    }
    saved = await patchItem(accountId, "journalist", id, { pitch: made.pitch, pitchNote: null, pitchNoteKind: null, pitchNoteAt: null }, "pitch");
    // Another draft of the same pitch landed first: that one stands.
    return { ok: true };
  } catch (e) {
    const out = (e as Error).name === "OutOfTime" ? "It ran out of time and tries again next week." : (e as Error).name === "SpendingLimitReached" ? String((e as Error).message) : "Writing the pitch failed. It tries again next week.";
    await patchItem(accountId, "journalist", id, note(out, false)).catch(() => undefined);
    if ((e as Error).name === "OutOfTime" || (e as Error).name === "SpendingLimitReached") return { ok: false, status: 503, error: out };
    throw e;
  } finally {
    if (!saved) await releaseDraftSlot(accountId, stamp).catch((e) => console.error(`press draft slot not given back: ${(e as Error).message}`));
  }
}

export async function setJournalistStatus(accountId: string, id: string, status: JournalistStatus): Promise<void> {
  if (!["new", "pitched", "replied", "covered", "dismissed"].includes(status)) throw new Error("Pick a status.");
  await tables();
  await setOwnerFields(accountId, "journalist", id, { status, statusAt: new Date().toISOString() });
}

export async function dismissPaid(accountId: string, url: string): Promise<void> {
  await tables();
  await setOwnerFields(accountId, "paid", itemId(url), { dismissed: true });
}

export async function dismissRequest(accountId: string, url: string): Promise<void> {
  await tables();
  await setOwnerFields(accountId, "request", itemId(url), { dismissed: true });
}

// ---------- the weekly runs ----------

/** Article pages read per run, paid pages read per run, journalists kept. */
const ARTICLES_PER_RUN = 10;
const PAID_PAGES_PER_RUN = 8;
const MAX_JOURNALISTS = 60;

/** The Journalists agent and paid opportunities, for one site. */
async function pressWork(accountId: string, deadline: number): Promise<RunOutcome> {
  await tables();
  const ctx = await context(accountId);
  if ("skip" in ctx) return { note: `Journalists skipped: ${ctx.skip}.`, skip: true };
  if (!ctx.topics.length) return { note: "Journalists skipped: the site has no searches or products of its own yet.", skip: true };
  const [{ readPlatformSettings }, { fetchNews, fetchSerp }, { clientListKnown, otherClient }, { nullUnlessLimit }] = await Promise.all([
    import("./settings"),
    import("./serp"),
    import("./clients"),
    import("./usage"),
  ]);
  const key = (await readPlatformSettings()).serperKey;
  if (!key) return { note: "Journalists wait for a search key.", problem: "No search key (Serper) is set up, so journalists and paid placements can't be searched." };
  // Without the customer list other customers can't be told apart: nothing is saved this time.
  if (!(await clientListKnown())) return { note: "Journalists wait: the customer list couldn't be read.", retryInDays: 1, problem: "The customer list couldn't be read, so no journalists were saved this week." };
  const isOther = await otherClient(ctx.domain);
  const issues: string[] = [];
  const oldJournalists = await readItems<Journalist>(accountId, "journalist");
  const oldPaid = await readItems<PaidOpportunity>(accountId, "paid");

  // Journalists: recent articles on the site's topics, each read for its printed byline.
  const news: { n: NewsResult; topic: string }[] = [];
  for (const t of ctx.topics) {
    if (Date.now() > deadline) break;
    const found = await fetchNews(key, t).catch((e) => {
      nullUnlessLimit(e);
      issues.push(`The news search failed for "${t}".`);
      return [] as NewsResult[];
    });
    for (const n of found) if (!news.some((x) => x.n.link === n.link)) news.push({ n, topic: t });
  }
  const known = new Set(oldJournalists.map((j) => j.articleUrl));
  const toRead = news.filter(({ n }) => !known.has(n.link) && !isOther(n.domain) && !NOT_PROSPECTS.test(bare(n.domain))).slice(0, ARTICLES_PER_RUN);
  const fresh: Journalist[] = [];
  for (let i = 0; i < toRead.length && deadline - Date.now() > 8_000; i += 4) {
    await Promise.all(
      toRead.slice(i, i + 4).map(async ({ n, topic }) => {
        const html = await readPage(n.link, 8_000);
        const j = html ? journalistFrom(n, html, topic, ctx.domain, isOther) : null;
        if (j && !fresh.some((x) => x.id === j.id)) fresh.push(j);
      }),
    );
  }
  for (const j of fresh) await addItem(accountId, "journalist", j.id, j as unknown as Record<string, unknown>);
  // Only the oldest untouched finds go when the list is full: never one the owner marked or one with a pitch.
  await sql`
    DELETE FROM insights_press_items WHERE account_id = ${accountId} AND kind = 'journalist' AND owner = '{}'::jsonb AND data -> 'pitch' IS NULL
      AND item_id IN (SELECT item_id FROM insights_press_items WHERE account_id = ${accountId} AND kind = 'journalist' ORDER BY found_at DESC OFFSET ${MAX_JOURNALISTS})`;

  // Paid opportunities: pages on the topic that say they sell placements, read to confirm and for a stated price.
  const paidQueries = ctx.topics.slice(0, 1).flatMap((t) => [
    { q: `"${t}" "advertise with us"`, t },
    { q: `"${t}" newsletter "sponsor"`, t },
    { q: `"${t}" podcast "sponsorship"`, t },
    { q: `"${t}" "media kit"`, t },
    { q: `"${t}" "sponsored post"`, t },
  ]);
  const paidFound = new Map<string, { r: SerpResult; t: string }>();
  for (const { q, t } of paidQueries) {
    if (Date.now() > deadline) break;
    const serp = await fetchSerp(key, q).catch((e) => {
      nullUnlessLimit(e);
      issues.push("A paid placement search failed.");
      return null;
    });
    for (const r of serp?.organic ?? []) {
      const d = bare(r.domain);
      if (!d || d === bare(ctx.domain) || d.endsWith(`.${bare(ctx.domain)}`) || isOther(d) || NOT_PROSPECTS.test(d)) continue;
      if (!isPaidPlacement(r.link, r.title, r.snippet) || [...paidFound.values()].some((x) => bare(x.r.domain) === d)) continue;
      paidFound.set(r.link, { r, t });
    }
  }
  const paidKnown = new Set(oldPaid.map((p) => p.url));
  const paidNew = [...paidFound.values()].filter(({ r }) => !paidKnown.has(r.link)).slice(0, PAID_PAGES_PER_RUN);
  let paidAdded = 0;
  await Promise.all(
    paidNew.map(async ({ r, t }) => {
      if (deadline - Date.now() < 6_000) return;
      const text = toText(await readPage(r.link, 8_000));
      // Only a page that itself says it sells placements is listed.
      if (!text || !isPaidPlacement("", "", text)) return;
      const item: PaidOpportunity = {
        url: r.link,
        outlet: r.title.split(/\s[|–—-]\s/).pop()?.trim() || bare(r.domain),
        domain: bare(r.domain),
        type: paidType(`${r.title} ${r.snippet} ${text.slice(0, 3000)}`),
        title: r.title.slice(0, 160),
        price: statedPrice(text),
        topic: t,
        foundAt: new Date().toISOString(),
      };
      await addItem(accountId, "paid", itemId(r.link), item as unknown as Record<string, unknown>);
      paidAdded++;
    }),
  );
  await writeMeta(pressMetaKey(accountId), { updatedAt: new Date().toISOString(), topics: ctx.topics });

  // Pitches for the newest journalists, within the week's five drafts and the run's deadline.
  let drafted = 0;
  for (const j of (await readItems<Journalist>(accountId, "journalist")).filter((x) => autoDraftable(x))) {
    if (deadline - Date.now() < 30_000) break;
    const r = await draftPitch(accountId, j.id, deadline).catch((e) => ({ ok: false as const, status: 500, error: (e as Error).message }));
    if (r.ok) drafted++;
    else if (r.status === 429) break;
    else if (/second AI|AI key|AI limit|ran out of time/i.test(r.error)) {
      issues.push(r.error);
      break;
    }
  }
  return {
    note: `${fresh.length} new ${fresh.length === 1 ? "journalist" : "journalists"}, ${drafted} ${drafted === 1 ? "pitch" : "pitches"} written, ${paidAdded} new paid ${paidAdded === 1 ? "opportunity" : "opportunities"}`,
    ...(issues.length ? { problem: [...new Set(issues)].join(" ") } : {}),
  };
}

/** Media requests for one site: public requests for sources on its topics. */
async function requestsWork(accountId: string, deadline: number): Promise<RunOutcome> {
  await tables();
  const ctx = await context(accountId);
  if ("skip" in ctx) return { note: `Media requests skipped: ${ctx.skip}.`, skip: true };
  if (!ctx.topics.length) return { note: "Media requests skipped: the site has no searches or products of its own yet.", skip: true };
  const [{ readPlatformSettings }, { fetchSerp }, { clientListKnown, otherClient }, { nullUnlessLimit }] = await Promise.all([
    import("./settings"),
    import("./serp"),
    import("./clients"),
    import("./usage"),
  ]);
  const key = (await readPlatformSettings()).serperKey;
  if (!key) return { note: "Media requests wait for a search key.", problem: "No search key (Serper) is set up, so media requests can't be searched." };
  if (!(await clientListKnown())) return { note: "Media requests wait: the customer list couldn't be read.", retryInDays: 1, problem: "The customer list couldn't be read, so no media requests were saved this week." };
  const isOther = await otherClient(ctx.domain);
  const sites = SOURCE_PLATFORMS.map((p) => `site:${p.host}`).join(" OR ");
  const queries = ctx.topics.slice(0, 2).flatMap((t) => [
    { q: `"journalist looking for sources" "${t}"`, t },
    { q: `"looking for experts" journalist "${t}"`, t },
    { q: `"${t}" (${sites})`, t },
  ]);
  let answered = 0;
  let failed = 0;
  const found = new Map<string, MediaRequest>();
  for (const { q, t } of queries) {
    if (Date.now() > deadline) break;
    const serp = await fetchSerp(key, q).catch((e) => (nullUnlessLimit(e), null));
    if (!serp) {
      failed++;
      continue;
    }
    answered++;
    for (const r of serp.organic) {
      const m = requestFrom(r, t, ctx.domain, isOther);
      if (m && !found.has(m.url)) found.set(m.url, m);
    }
  }
  if (!answered) return { note: "Media requests: the search didn't answer this week.", retryInDays: 1, problem: "The search for media requests failed this week." };
  for (const r of found.values()) await addItem(accountId, "request", itemId(r.url), r as unknown as Record<string, unknown>);
  // Requests older than a month go, unless the owner acted on one or an answer was written for it.
  await sql`
    DELETE FROM insights_press_items WHERE account_id = ${accountId} AND kind = 'request' AND owner = '{}'::jsonb AND data -> 'answer' IS NULL
      AND found_at < now() - interval '30 days'`;
  await writeMeta(requestMetaKey(accountId), { updatedAt: new Date().toISOString(), readable: true });
  const n = `${found.size} media ${found.size === 1 ? "request" : "requests"} found`;
  return failed
    ? { note: n, problem: `${failed} of ${answered + failed} media request searches failed this week; the requests that were found are listed.` }
    : { note: n };
}

/** The owner's Draft an answer: from the site's own page that best matches the request, checked like a pitch. */
export async function draftAnswer(accountId: string, url: string): Promise<DraftResult> {
  const id = itemId(url);
  const req = await readItem<MediaRequest>(accountId, "request", id);
  if (!req || req.dismissed) return { ok: false, status: 404, error: "That request isn't on the list anymore." };
  if (req.answer) return { ok: true };
  const ctx = await context(accountId);
  if ("skip" in ctx) return { ok: false, status: 409, error: "Add your website address first." };
  const [{ sitePages }, { aiProvider, readPlatformSettings }, { writeSourceAnswer, secondCheck }, { cleanPost }, { readProfile, siteBrief }] = await Promise.all([
    import("../site-crawl"),
    import("./settings"),
    import("./writer"),
    import("../social-agent"),
    import("../profile"),
  ]);
  const want = topicTerms(`${req.title} ${req.snippet} ${req.topic}`);
  const page = (await sitePages(accountId))
    .map((p) => ({ p, score: [...topicTerms(`${p.title} ${p.h1 ?? ""} ${p.text.slice(0, 2000)}`)].filter((w) => want.has(w)).length }))
    .sort((a, b) => b.score - a.score)[0];
  if (!page || page.score < 2) {
    const msg = "None of your pages answers this request, so no answer was written.";
    await patchItem(accountId, "request", id, { answerNote: msg });
    return { ok: false, status: 422, error: msg };
  }
  const base = aiProvider(await readPlatformSettings());
  if (!base) return { ok: false, status: 400, error: "An AI key is needed to write the answer." };
  const stamp = await takeDraftSlot(accountId);
  if (!stamp) return { ok: false, status: 429, error: await capMessage(accountId) };
  let saved = false;
  try {
    const ai = { ...base, site: siteBrief(await readProfile(accountId)) };
    const raw = await writeSourceAnswer(ai, { request: `${req.title}\n${req.snippet}`, pageTitle: page.p.title, pageText: page.p.text, brand: ctx.brand, site: ctx.domain, health: ctx.health });
    const clean = cleanPost(raw, [ctx.brand, ctx.domain].filter((x): x is string => Boolean(x)), 900, ctx.health);
    const problem = !clean.text ? "The page doesn't answer it." : (pitchProblem(clean.text, ctx.health) ?? clean.problem);
    const verdict = problem ? null : await secondCheck(ai, { what: "an answer from a business to a journalist's request for sources", source: page.p.text, text: clean.text, health: ctx.health });
    const msg = problem ?? (!verdict ? "No second AI from another service was free to check it, so no answer was written." : !verdict.ok ? `The second AI turned it down: ${plainWords(verdict.why || "no reason given")}` : null);
    if (msg) {
      await patchItem(accountId, "request", id, { answerNote: msg });
      return { ok: false, status: 422, error: msg };
    }
    saved = await patchItem(accountId, "request", id, { answer: { text: plainWords(clean.text), page: page.p.url, at: new Date().toISOString() }, answerNote: null }, "answer");
    return { ok: true };
  } finally {
    if (!saved) await releaseDraftSlot(accountId, stamp).catch((e) => console.error(`press draft slot not given back: ${(e as Error).message}`));
  }
}

export const PRESS_STARTED = "The last journalist search didn't finish. It tries again within a day.";
export const REQUESTS_STARTED = "The last media request search didn't finish. It tries again within a day.";

/** What the owner reads about a failed run: a spending limit as it is, anything else in plain words. */
export function plainOutreachFailure(e: unknown): string {
  if ((e as Error)?.name === "SpendingLimitReached") return String((e as Error).message);
  return "The search hit a problem and tries again next week.";
}

const baseDeps = (accountId: string) => ({
  sabbath: () => isSabbath(),
  autopilotOn: async () => (await import("./settings").then((m) => m.readAccountAutopilot(accountId))).enabled,
  plainFailure: plainOutreachFailure,
});

/** One site's weekly journalist and paid placement search (status part "press"). */
export function runPress(accountId: string, deadline = Date.now() + 150_000): Promise<string> {
  return runWeekly({
    ...baseDeps(accountId),
    name: "Journalists",
    started: PRESS_STARTED,
    mark: (n, days) => saveRunMarker(`${PRESS_RUN}:${accountId}`, n, days),
    report: (ok, detail) => import("./status").then((m) => m.report("press", ok, detail)),
    work: () => pressWork(accountId, deadline),
  });
}

/** One site's weekly media request search (status part "media-requests"). */
export function runMediaRequests(accountId: string, deadline = Date.now() + 90_000): Promise<string> {
  return runWeekly({
    ...baseDeps(accountId),
    name: "Media requests",
    started: REQUESTS_STARTED,
    mark: (n, days) => saveRunMarker(`${REQUEST_RUN}:${accountId}`, n, days),
    report: (ok, detail) => import("./status").then((m) => m.report("media-requests", ok, detail)),
    work: () => requestsWork(accountId, deadline),
  });
}

// ---------- the Outreach tab ----------

export async function outreachView(accountId: string) {
  await tables();
  const [journalists, requests, paid, counts, pressMeta, requestMeta, pressNote, requestNote] = await Promise.all([
    readItems<Journalist>(accountId, "journalist"),
    readItems<MediaRequest>(accountId, "request"),
    readItems<PaidOpportunity>(accountId, "paid"),
    slotCounts(accountId),
    readMeta<{ topics: string[] }>(pressMetaKey(accountId)),
    readMeta<{ readable: boolean }>(requestMetaKey(accountId)),
    readRunNote(`${PRESS_RUN}:${accountId}`),
    readRunNote(`${REQUEST_RUN}:${accountId}`),
  ]);
  // Checked again on every view: a site that became another customer's since is never shown.
  const { otherClient } = await import("./clients");
  const { readProfile } = await import("../profile");
  const isOther = await otherClient((await readProfile(accountId)).siteDomain ?? "");
  const order: Record<JournalistStatus, number> = { new: 0, pitched: 1, replied: 2, covered: 3, dismissed: 4 };
  const shown = requests.filter((r) => !r.dismissed && !isOther(r.url));
  return {
    journalists: journalists
      .filter((j) => j.status !== "dismissed" && !isOther(j.outletDomain))
      .map((j) => (j.email && j.emailIsOutlets && !outletEmailOk(j.email, j.outletDomain, isOther) ? { ...j, email: null } : j))
      .sort((a, b) => Number(Boolean(b.pitch)) - Number(Boolean(a.pitch)) || order[a.status] - order[b.status]),
    topics: pressMeta?.topics ?? [],
    paid: paid.filter((p) => !p.dismissed && !isOther(p.domain)),
    paidNote: PAID_NOTE,
    requests: shown,
    requestsNote:
      shown.length > 0
        ? null
        : requestMeta?.readable
          ? "No public requests for sources on your topics were found this week. Signing up on these sites gets their requests sent to you."
          : "No public requests for sources could be read yet. Signing up on these sites gets their requests sent to you.",
    platforms: SOURCE_PLATFORMS,
    draftsLeft: Math.max(0, PITCH_WEEKLY_CAP - counts.drafts),
    cap: PITCH_WEEKLY_CAP,
    lastRun: { press: pressNote, requests: requestNote },
  };
}
