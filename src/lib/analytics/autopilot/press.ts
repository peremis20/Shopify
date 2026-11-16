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
  pitchNote?: string;
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

/** An email the article prints next to the author's name (within the byline area), or null. Never a guessed one. */
export function emailNearByline(html: string, author: string): string | null {
  const text = html.replace(/\s+/g, " ");
  const at = text.toLowerCase().indexOf(author.toLowerCase());
  if (at < 0) return null;
  const near = text.slice(at, at + 600);
  const m = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(near);
  return m ? m[1].toLowerCase() : null;
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
    date: publishedOf(html) ?? n.date,
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
  // Only an amount near words about the placement or its price: not a product price elsewhere on the page.
  const around = t.slice(Math.max(0, m.index - 160), m.index + m[0].length + 160);
  return /sponsor|advertis|placement|rate|pricing|price|cost|starts? at|from|package|ad\b|spot|issue|episode|media kit/i.test(around) ? m[0].trim() : null;
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

// ---------- storage ----------

interface PressData {
  updatedAt: string;
  topics: string[];
  journalists: Journalist[];
  paid: PaidOpportunity[];
}
interface RequestData {
  updatedAt: string;
  /** Whether any public request source could be read this week. */
  readable: boolean;
  requests: MediaRequest[];
}
interface DraftLog {
  drafts: string[];
  attempts: string[];
}

const pressKey = (a: string) => `press:${a}`;
const requestKey = (a: string) => `media_requests:${a}`;
const draftKey = (a: string) => `press_drafts:${a}`;
const PRESS_RUN = "press_run";
const REQUEST_RUN = "media_requests_run";

async function readJson<T>(key: string): Promise<T | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key}`;
  try {
    return row?.value ? (JSON.parse(String(row.value)) as T) : null;
  } catch {
    return null;
  }
}
async function writeJson(key: string, v: unknown): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key}, ${JSON.stringify(v)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const accountsDueForPress = (limit: number) => ensureSchema().then(() => accountsDueWeekly(PRESS_RUN, limit));
export const accountsDueForMediaRequests = (limit: number) => ensureSchema().then(() => accountsDueWeekly(REQUEST_RUN, limit));

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

/** Takes one AI attempt for today, if there's room. */
async function takeAttempt(accountId: string): Promise<boolean> {
  const log = (await readJson<DraftLog>(draftKey(accountId))) ?? { drafts: [], attempts: [] };
  if (!attemptRoom(log.attempts)) return false;
  const now = Date.now();
  log.attempts = [...log.attempts.filter((t) => now - Date.parse(t) < 864e5), new Date().toISOString()];
  await writeJson(draftKey(accountId), log);
  return true;
}
async function draftsLeft(accountId: string): Promise<number> {
  return draftRoom(((await readJson<DraftLog>(draftKey(accountId))) ?? { drafts: [], attempts: [] }).drafts);
}
async function countDraft(accountId: string): Promise<void> {
  const log = (await readJson<DraftLog>(draftKey(accountId))) ?? { drafts: [], attempts: [] };
  const now = Date.now();
  log.drafts = [...log.drafts.filter((t) => now - Date.parse(t) < 7 * 864e5), new Date().toISOString()];
  await writeJson(draftKey(accountId), log);
}

/**
 * Writes and checks a pitch: the claim guard on every sentence, then a second AI from another service against the
 * business's own offer. Without a second AI no pitch is written.
 */
async function makePitch(ctx: Context, j: Journalist): Promise<{ pitch: Pitch } | { note: string }> {
  const [{ aiProvider, readPlatformSettings }, { writePressPitch, secondCheck }, { cleanPost }, { readProfile, siteBrief }] = await Promise.all([
    import("./settings"),
    import("./writer"),
    import("../social-agent"),
    import("../profile"),
  ]);
  const base = aiProvider(await readPlatformSettings());
  if (!base) return { note: "An AI key is needed to write pitches." };
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
  if (problem || !body.text || !subject.text) return { note: problem ?? "The checks removed too much of it." };
  const text = composePitch(j.name, body.text, ctx.brand, ctx.domain);
  const verdict = await secondCheck(ai, {
    what: `a first email from a business owner to a journalist, offering ${offerKind === "sample" ? "a product sample to review" : "an expert quote"}`,
    source: `What the business offers: ${ctx.offer}\n${ctx.expertise ? `What it knows well: ${ctx.expertise}\n` : ""}The journalist's article title: ${j.articleTitle}`,
    text: `${subject.text}\n\n${text}`,
    health: ctx.health,
  });
  if (!verdict) return { note: "No second AI from another service was free to check it, so no pitch was written. It tries again next week." };
  if (!verdict.ok) return { note: `The second AI turned it down: ${plainWords(verdict.why || "no reason given")}` };
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

/** The owner's Draft pitch click (and the weekly run): within five drafts a week and ten attempts a day. */
export async function draftPitch(accountId: string, id: string): Promise<DraftResult> {
  const data = await readJson<PressData>(pressKey(accountId));
  const j = data?.journalists.find((x) => x.id === id && x.status !== "dismissed");
  if (!data || !j) return { ok: false, status: 404, error: "That journalist isn't on the list anymore." };
  if (j.pitch) return { ok: true };
  if (!(await draftsLeft(accountId))) return { ok: false, status: 429, error: `${PITCH_WEEKLY_CAP} drafts were written in the last seven days, the most allowed. More next week.` };
  if (!(await takeAttempt(accountId))) return { ok: false, status: 429, error: `${ATTEMPT_DAILY_CAP} drafts were tried today, the most allowed. Try again tomorrow.` };
  const ctx = await context(accountId);
  if ("skip" in ctx) return { ok: false, status: 409, error: "Add your website address first." };
  if (!j.email && !j.contactPage) {
    // Only a printed address: the outlet's published email, labeled as the outlet's.
    const { findContactEmail } = await import("./contact-finder");
    const outletEmail = await findContactEmail(j.articleUrl, j.outletDomain).catch(() => null);
    if (outletEmail) Object.assign(j, { email: outletEmail, emailIsOutlets: true });
  }
  const made = await makePitch(ctx, j);
  const fresh = (await readJson<PressData>(pressKey(accountId))) ?? data;
  fresh.journalists = fresh.journalists.map((x) =>
    x.id === id ? { ...x, email: j.email, emailIsOutlets: j.emailIsOutlets, ...("pitch" in made ? { pitch: made.pitch, pitchNote: undefined } : { pitchNote: made.note }) } : x,
  );
  await writeJson(pressKey(accountId), fresh);
  if (!("pitch" in made)) return { ok: false, status: 422, error: made.note };
  await countDraft(accountId);
  return { ok: true };
}

export async function setJournalistStatus(accountId: string, id: string, status: JournalistStatus): Promise<void> {
  if (!["new", "pitched", "replied", "covered", "dismissed"].includes(status)) throw new Error("Pick a status.");
  const data = await readJson<PressData>(pressKey(accountId));
  if (!data) return;
  data.journalists = data.journalists.map((j) => (j.id === id ? { ...j, status, statusAt: new Date().toISOString() } : j));
  await writeJson(pressKey(accountId), data);
}

export async function dismissPaid(accountId: string, url: string): Promise<void> {
  const data = await readJson<PressData>(pressKey(accountId));
  if (!data) return;
  data.paid = data.paid.map((p) => (p.url === url ? { ...p, dismissed: true } : p));
  await writeJson(pressKey(accountId), data);
}

// ---------- the weekly runs ----------

/** Journalists found per run, article pages read per run, paid pages read per run. */
const ARTICLES_PER_RUN = 10;
const PAID_PAGES_PER_RUN = 8;
const MAX_JOURNALISTS = 60;

/** The Journalists agent and paid opportunities, for one site. */
async function pressWork(accountId: string, deadline: number): Promise<RunOutcome> {
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
  const old = (await readJson<PressData>(pressKey(accountId))) ?? { updatedAt: "", topics: [], journalists: [], paid: [] };
  const issues: string[] = [];

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
  const known = new Set(old.journalists.map((j) => j.articleUrl));
  const toRead = news.filter(({ n }) => !known.has(n.link) && !isOther(n.domain) && !NOT_PROSPECTS.test(bare(n.domain))).slice(0, ARTICLES_PER_RUN);
  const fresh: Journalist[] = [];
  for (let i = 0; i < toRead.length && deadline - Date.now() > 8_000; i += 4) {
    await Promise.all(
      toRead.slice(i, i + 4).map(async ({ n, topic }) => {
        const html = await readPage(n.link, 8_000);
        const j = html ? journalistFrom(n, html, topic, ctx.domain, isOther) : null;
        if (j) fresh.push(j);
      }),
    );
  }
  const byId = new Map(old.journalists.filter((j) => !isOther(j.outletDomain)).map((j) => [j.id, j]));
  for (const j of fresh) if (!byId.has(j.id)) byId.set(j.id, j);
  const order: Record<JournalistStatus, number> = { new: 0, pitched: 1, replied: 2, covered: 3, dismissed: 4 };
  const journalists = [...byId.values()].sort((a, b) => order[a.status] - order[b.status] || b.foundAt.localeCompare(a.foundAt)).slice(0, MAX_JOURNALISTS);

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
  const paidKnown = new Map(old.paid.filter((p) => !isOther(p.domain)).map((p) => [p.url, p]));
  const paidNew = [...paidFound.values()].filter(({ r }) => !paidKnown.has(r.link)).slice(0, PAID_PAGES_PER_RUN);
  await Promise.all(
    paidNew.map(async ({ r, t }) => {
      if (deadline - Date.now() < 6_000) return;
      const text = toText(await readPage(r.link, 8_000));
      // Only a page that itself says it sells placements is listed.
      if (!text || !isPaidPlacement("", "", text)) return;
      paidKnown.set(r.link, { url: r.link, outlet: r.title.split(/\s[|–—-]\s/).pop()?.trim() || bare(r.domain), domain: bare(r.domain), type: paidType(`${r.title} ${r.snippet} ${text.slice(0, 3000)}`), title: r.title.slice(0, 160), price: statedPrice(text), topic: t, foundAt: new Date().toISOString() });
    }),
  );

  const data: PressData = { updatedAt: new Date().toISOString(), topics: ctx.topics, journalists, paid: [...paidKnown.values()].slice(0, 30) };
  await writeJson(pressKey(accountId), data);

  // Pitches for the newest journalists, within the week's five drafts.
  let drafted = 0;
  const notes: string[] = [];
  for (const j of journalists.filter((x) => x.status === "new" && !x.pitch && !x.pitchNote)) {
    if (deadline - Date.now() < 30_000 || !(await draftsLeft(accountId))) break;
    const r = await draftPitch(accountId, j.id).catch((e) => ({ ok: false as const, status: 500, error: (e as Error).message }));
    if (r.ok) drafted++;
    else if (r.status === 429) break;
    else notes.push(r.error);
    if (/second AI|AI key|AI limit/i.test(r.ok ? "" : r.error)) break;
  }
  if (notes.some((n) => /second AI from another service|AI key|AI limit/i.test(n))) issues.push(notes.find((n) => /second AI from another service|AI key|AI limit/i.test(n))!);
  return {
    note: `${fresh.length} new ${fresh.length === 1 ? "journalist" : "journalists"}, ${drafted} ${drafted === 1 ? "pitch" : "pitches"} written, ${data.paid.length} paid ${data.paid.length === 1 ? "opportunity" : "opportunities"}`,
    ...(issues.length ? { problem: [...new Set(issues)].join(" ") } : {}),
  };
}

/** Media requests for one site: public requests for sources on its topics. */
async function requestsWork(accountId: string, deadline: number): Promise<RunOutcome> {
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
  const old = (await readJson<RequestData>(requestKey(accountId))) ?? { updatedAt: "", readable: false, requests: [] };
  let answered = 0;
  const found = new Map<string, MediaRequest>();
  for (const { q, t } of queries) {
    if (Date.now() > deadline) break;
    const serp = await fetchSerp(key, q).catch((e) => (nullUnlessLimit(e), null));
    if (!serp) continue;
    answered++;
    for (const r of serp.organic) {
      const m = requestFrom(r, t, ctx.domain, isOther);
      if (m && !found.has(m.url)) found.set(m.url, m);
    }
  }
  if (!answered) return { note: "Media requests: the search didn't answer this week.", retryInDays: 1, problem: "The search for media requests failed this week." };
  const keep = new Map(old.requests.filter((r) => !isOther(r.url) && (r.answer || r.dismissed || Date.now() - Date.parse(r.foundAt) < 30 * 864e5)).map((r) => [r.url, r]));
  for (const r of found.values()) if (!keep.has(r.url)) keep.set(r.url, r);
  const data: RequestData = { updatedAt: new Date().toISOString(), readable: true, requests: [...keep.values()].sort((a, b) => b.foundAt.localeCompare(a.foundAt)).slice(0, 30) };
  await writeJson(requestKey(accountId), data);
  return { note: `${found.size} media ${found.size === 1 ? "request" : "requests"} found` };
}

/** The owner's Draft an answer: from the site's own page that best matches the request, checked like a pitch. */
export async function draftAnswer(accountId: string, url: string): Promise<DraftResult> {
  const data = await readJson<RequestData>(requestKey(accountId));
  const req = data?.requests.find((r) => r.url === url && !r.dismissed);
  if (!data || !req) return { ok: false, status: 404, error: "That request isn't on the list anymore." };
  if (req.answer) return { ok: true };
  if (!(await draftsLeft(accountId))) return { ok: false, status: 429, error: `${PITCH_WEEKLY_CAP} drafts were written in the last seven days, the most allowed. More next week.` };
  if (!(await takeAttempt(accountId))) return { ok: false, status: 429, error: `${ATTEMPT_DAILY_CAP} drafts were tried today, the most allowed. Try again tomorrow.` };
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
  const save = async (patch: Partial<MediaRequest>) => {
    const fresh = (await readJson<RequestData>(requestKey(accountId))) ?? data;
    fresh.requests = fresh.requests.map((r) => (r.url === url ? { ...r, ...patch } : r));
    await writeJson(requestKey(accountId), fresh);
  };
  if (!page || page.score < 2) {
    await save({ answerNote: "None of your pages answers this request, so no answer was written." });
    return { ok: false, status: 422, error: "None of your pages answers this request, so no answer was written." };
  }
  const base = aiProvider(await readPlatformSettings());
  if (!base) return { ok: false, status: 400, error: "An AI key is needed to write the answer." };
  const ai = { ...base, site: siteBrief(await readProfile(accountId)) };
  const raw = await writeSourceAnswer(ai, { request: `${req.title}\n${req.snippet}`, pageTitle: page.p.title, pageText: page.p.text, brand: ctx.brand, site: ctx.domain, health: ctx.health });
  const clean = cleanPost(raw, [ctx.brand, ctx.domain].filter((x): x is string => Boolean(x)), 900, ctx.health);
  const problem = !clean.text ? "The page doesn't answer it." : (pitchProblem(clean.text, ctx.health) ?? clean.problem);
  const verdict = problem ? null : await secondCheck(ai, { what: "an answer from a business to a journalist's request for sources", source: page.p.text, text: clean.text, health: ctx.health });
  const note = problem ?? (!verdict ? "No second AI from another service was free to check it, so no answer was written." : !verdict.ok ? `The second AI turned it down: ${plainWords(verdict.why || "no reason given")}` : null);
  if (note) {
    await save({ answerNote: note });
    return { ok: false, status: 422, error: note };
  }
  await save({ answer: { text: plainWords(clean.text), page: page.p.url, at: new Date().toISOString() }, answerNote: undefined });
  await countDraft(accountId);
  return { ok: true };
}

export async function dismissRequest(accountId: string, url: string): Promise<void> {
  const data = await readJson<RequestData>(requestKey(accountId));
  if (!data) return;
  data.requests = data.requests.map((r) => (r.url === url ? { ...r, dismissed: true } : r));
  await writeJson(requestKey(accountId), data);
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
    mark: (note, days) => saveRunMarker(`${PRESS_RUN}:${accountId}`, note, days),
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
    mark: (note, days) => saveRunMarker(`${REQUEST_RUN}:${accountId}`, note, days),
    report: (ok, detail) => import("./status").then((m) => m.report("media-requests", ok, detail)),
    work: () => requestsWork(accountId, deadline),
  });
}

// ---------- the Outreach tab ----------

export async function outreachView(accountId: string) {
  const [press, requests, log, pressNote, requestNote] = await Promise.all([
    readJson<PressData>(pressKey(accountId)),
    readJson<RequestData>(requestKey(accountId)),
    readJson<DraftLog>(draftKey(accountId)),
    readRunNote(`${PRESS_RUN}:${accountId}`),
    readRunNote(`${REQUEST_RUN}:${accountId}`),
  ]);
  // Checked again on every view: a site that became another customer's since is never shown.
  const { otherClient } = await import("./clients");
  const { readProfile } = await import("../profile");
  const isOther = await otherClient((await readProfile(accountId)).siteDomain ?? "");
  const shown = (requests?.requests ?? []).filter((r) => !r.dismissed && !isOther(r.url));
  return {
    journalists: (press?.journalists ?? []).filter((j) => j.status !== "dismissed" && !isOther(j.outletDomain)),
    topics: press?.topics ?? [],
    paid: (press?.paid ?? []).filter((p) => !p.dismissed && !isOther(p.domain)),
    paidNote: PAID_NOTE,
    requests: shown,
    requestsNote:
      shown.length > 0
        ? null
        : requests?.readable
          ? "No public requests for sources on your topics were found this week. Signing up on these sites gets their requests sent to you."
          : "No public requests for sources could be read yet. Signing up on these sites gets their requests sent to you.",
    platforms: SOURCE_PLATFORMS,
    draftsLeft: draftRoom(log?.drafts ?? []),
    cap: PITCH_WEEKLY_CAP,
    lastRun: { press: pressNote, requests: requestNote },
  };
}
