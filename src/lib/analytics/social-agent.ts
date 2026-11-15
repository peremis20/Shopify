import { ensureSchema, sql } from "./db";
import { getConnection } from "./connection";
import { healthRulesApply, readProfile, siteBrief, type Profile } from "./profile";
import { querySearches28d } from "./seo-tools";
import { isPostUrl, sitePages } from "./site-crawl";
import { scanClaims } from "./autopilot/claims";
import { isSabbath } from "./autopilot/sabbath";
import { aiProvider, readAccountAutopilot, readPlatformSettings, type AiProvider } from "./autopilot/settings";
import { readSiteKeywords } from "./autopilot/site-keywords";
import { articleFromLog } from "./autopilot/share-kit";
import { report } from "./autopilot/status";
import { isUnsourced, safeEmailText, secondCheck, writeReplyAnswer, writeSocialPost, type SocialKind } from "./autopilot/writer";
import {
  dropThreadsScope,
  fetchReplies,
  hasScope,
  freshLink,
  keywordSearch,
  lacksPermission,
  needsReconnect,
  noteError,
  postThreadsText,
  threadsSchema,
  publishReply,
  taggedUrl,
  THREADS_MAX_CHARS,
  UnclearPublish,
  WEEKLY_POST_CAP,
  type ThreadsLink,
} from "./threads";

/**
 * The social agent for Threads. Once a day per site (never in the Sabbath), it drafts one short educational post (a
 * practical tip, a common question answered, or a short explainer, in turn) from the site's own pages, on what people
 * search for now (the site's own Search Console searches and cached Keyword Planner volumes), linking back to the page.
 * It reads the replies to the site's own posts and drafts helpful answers. Every draft passes the claim guard and a
 * second AI from another service; the owner approves it, unless they turned on automatic posting (posts) or automatic
 * replies (answers). Posts share the Threads weekly cap; answers have a small daily cap. Each site's own data only.
 */

export const SOCIAL_KINDS: SocialKind[] = ["tip", "question", "explainer"];
/** Answers to replies the agent drafts or posts for one site in a day. */
export const REPLY_DAILY_CAP = 10;
// A page posted about rests 21 days before it is used again (the query in draftNextPost).
/** Pages thinner than this have too little to post about. */
const MIN_WORDS = 120;
export const DOCTOR_LINE = "For your own situation, please ask your doctor.";

// ---------- pure parts (tested) ----------

/** The post type after the last one: tip, then a question answered, then an explainer, then a tip again. */
export function nextKind(last: string | null | undefined): SocialKind {
  const i = SOCIAL_KINDS.indexOf(last as SocialKind);
  return SOCIAL_KINDS[(i + 1) % SOCIAL_KINDS.length];
}

/** A page address compared without www, protocol, trailing slash, query or fragment. */
export const normUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "").toLowerCase()}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u.toLowerCase();
  }
};

export interface SourcePage {
  url: string;
  title: string;
  text: string;
  /** An article (blog post) rather than a product, home or other page. */
  article: boolean;
}

/** A search people make now: from Search Console (impressions) or Keyword Planner (monthly volume), with its page. */
export interface Demand {
  query: string;
  page: string | null;
  weight: number;
  /** Public Threads posts asking about it right now (counted only, never copied). */
  asked?: number;
}

const QUESTION = /^(?:how|what|why|when|which|who|where|can|does|do|is|are|should|will)\b/i;
const yes = (v: unknown) => ["t", "true"].includes(String(v));
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * What to post about: the page of the site with the most search demand right now that wasn't posted about lately, and
 * the search that brings it the most. A question post prefers searches written as questions or asked about on Threads.
 * With no search data, the newest article; never a topic that isn't the site's own page or a real search.
 */
export function pickTopic(
  pages: SourcePage[],
  demand: Demand[],
  recent: Set<string>,
  kind: SocialKind,
  brand?: string | null,
): { page: SourcePage; query: string; from: "search" | "page" } | null {
  const usable = pages.filter((p) => !recent.has(normUrl(p.url)) && wordCount(p.text) >= MIN_WORDS);
  if (!usable.length) return null;
  const byUrl = new Map(usable.map((p) => [normUrl(p.url), p]));
  const brandWord = brand?.trim().toLowerCase();
  const score = new Map<string, { page: SourcePage; total: number; query: string; best: number }>();
  for (const d of demand) {
    const page = d.page ? byUrl.get(normUrl(d.page)) : undefined;
    if (!page || !d.query.trim() || d.weight <= 0) continue;
    // A search for the brand itself is not a topic to teach about.
    if (brandWord && d.query.toLowerCase().includes(brandWord)) continue;
    const asked = d.asked ?? 0;
    const fits = kind === "question" && (QUESTION.test(d.query) || asked > 0) ? 3 : 1;
    const s = d.weight * fits * (1 + asked / 5);
    const key = normUrl(page.url);
    const cur = score.get(key) ?? { page, total: 0, query: d.query, best: 0 };
    cur.total += s;
    if (s > cur.best) Object.assign(cur, { best: s, query: d.query });
    score.set(key, cur);
  }
  const top = [...score.values()].sort((a, b) => b.total - a.total)[0];
  if (top) return { page: top.page, query: top.query, from: "search" };
  const page = usable.find((p) => p.article) ?? usable[0];
  return { page, query: page.title, from: "page" };
}

/** The site's own email signup page, when it has one. */
export function findSignupPage(urls: string[]): string | null {
  return urls.find((u) => /\/(?:[^/]*[-_])?(?:newsletter|subscribe|sign[-_]?up|mailing[-_]?list|email[-_]?list)(?:[-_/][^/]*)?\/?$/i.test(new URL(u).pathname)) ?? null;
}

/** Where the post sends people: the article itself, or for a page that isn't an article the email signup page if there is one. */
export function pickLink(page: Pick<SourcePage, "url" | "article">, signupUrl: string | null, source = "threads"): string {
  return taggedUrl(page.article || !signupUrl ? page.url : signupUrl, source, "dashpatrol_social");
}

/** Takes hyphens and dashes out of plain text (no links in it), so user facing text never has them. */
export function noDashes(text: string): string {
  return text
    .replace(/(?<=[\p{L}\p{N}])[-‐-―](?=[\p{L}\p{N}])/gu, " ")
    .replace(/\s*[-‐-―]+\s*/g, ", ")
    .replace(/^,\s*/, "")
    .replace(/,\s*([.?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Cut to fit, at the end of a sentence when one fits, otherwise at a word. */
export function fit(text: string, room: number): string {
  if (text.length <= room) return text;
  const cut = text.slice(0, room);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (end > room / 3) return cut.slice(0, end + 1).trim();
  return cut.replace(/\s+\S*$/, "").replace(/[,;:]$/, "").trim();
}

/** Words a health site's posts never use: promises of cure or treatment, doses, diagnosis. */
const HEALTH_PROMISE = /\b(?:cur(?:e|es|ed|ing)|treat(?:s|ed|ing|ment|ments)?|heal(?:s|ed|ing)?|remed(?:y|ies)|prescri\w*|diagnos\w*|dos(?:e|es|age|ing))\b/i;

/** Why a text can't go out (the claim guard, and for health sites no medical promises), or null when it passes. */
export function claimProblem(text: string, health: boolean): string | null {
  const flag = scanClaims(text)[0];
  if (flag) return `The claim guard stopped it: "${flag.phrase}". ${flag.why}`;
  if (health && HEALTH_PROMISE.test(text)) return "It talks about curing, treating or dosing, which a health site's posts never do.";
  if (isUnsourced(text)) return "It leans on sources nobody can check.";
  return null;
}

/**
 * The writer's text made safe: links taken out (the tagged one is added after), every sentence with a number, a claim,
 * an unsourced claim or AI wording dropped, no dashes, cut to fit. A problem when too much had to go.
 */
export function cleanPost(raw: string, keep: string[], room: number, health: boolean): { text: string; problem: string | null } {
  const noLinks = raw.replace(/https?:\/\/\S+/g, " ").replace(/[ \t]+/g, " ").trim();
  const safe = safeEmailText(noLinks, keep, []);
  if (!safe.text || safe.dropped > safe.total / 3) return { text: "", problem: "The checks removed too much of it (numbers, claims or AI wording)." };
  const text = fit(noDashes(safe.text), room);
  if (!text) return { text: "", problem: "Nothing was left after the checks." };
  return { text, problem: claimProblem(text, health) };
}

/** The post as it goes out: the text, then the tagged link on its own line, within Threads' limit. */
export function composePost(body: string, link: string): string {
  return `${fit(body, THREADS_MAX_CHARS - link.length - 2)}\n\n${link}`;
}

/** The room the text has next to its link. */
export const roomFor = (link: string) => THREADS_MAX_CHARS - link.length - 2;

const SPAM = /https?:\/\/|www\.|\b(?:dm me|message me|check (?:out )?my|follow (?:me|back)|link in (?:my )?bio|giveaway|crypto|bitcoin|forex|onlyfans|whatsapp|telegram|promo code|discount code|earn \$|make money|investment)\b/i;
const ABUSE = /\b(?:idiot|stupid|moron|scam(?:mer)?s?|fuck\w*|shit\w*|bitch\w*|asshole|dumb\w*|liar|kill yourself|kys)\b/i;
const HEALTH_WORDS =
  /\b(?:health|doctor|symptom\w*|pain|sleep|anxiety|depress\w*|blood|sugar|pressure|heart|medic\w*|pill\w*|supplement\w*|vitamin\w*|magnesium|diet|weight|pregnan\w*|disease|condition|dose|dosage|side effects?|allerg\w*|gut|digest\w*|hormone\w*|thyroid|diabet\w*|cholesterol|inflam\w*|immune|infection|skin|headache|migraine|tired|fatigue)\b/i;

/** Whether a reply is worth answering, and why not when it isn't. Spam, abuse and empty reactions are skipped. */
export function classifyReply(text: string, from: string, ownUsername: string): { kind: "question" | "comment" | "skip"; reason: string | null } {
  const t = text.trim();
  if (from && ownUsername && from.toLowerCase() === ownUsername.toLowerCase()) return { kind: "skip", reason: "Our own reply." };
  if (!t || !/\p{L}/u.test(t)) return { kind: "skip", reason: "No words to answer." };
  if (SPAM.test(t)) return { kind: "skip", reason: "Looks like spam." };
  if (ABUSE.test(t)) return { kind: "skip", reason: "Unkind or abusive, so it is left alone." };
  if (t.includes("?") || QUESTION.test(t)) return { kind: "question", reason: null };
  if (wordCount(t) < 5) return { kind: "skip", reason: "A short reaction, nothing to answer." };
  return { kind: "comment", reason: null };
}

/**
 * Whose answer ends by asking them to talk to their doctor: any question on a health site, any question elsewhere that
 * mentions the body, symptoms or medicines, and on a health site any comment that touches health.
 */
export const isHealthQuestion = (text: string, healthSite: boolean, kind: "question" | "comment" | "skip") =>
  (kind === "question" && (healthSite || HEALTH_WORDS.test(text))) || (kind === "comment" && healthSite && HEALTH_WORDS.test(text));

/** The answer with the line asking them to talk to their doctor, always last and always whole. */
export function withDoctorLine(answer: string): string {
  const body = answer.replace(/\s*(?:for your own situation, )?please (?:ask|talk to|check with) your doctor[^.]*\.?\s*$/i, "").trim();
  const room = THREADS_MAX_CHARS - DOCTOR_LINE.length - 1;
  return `${fit(body, room)} ${DOCTOR_LINE}`.trim();
}

/** One reply is answered once: the key it is stored under for each site. */
export const replyKey = (accountId: string, replyId: string) => `${accountId}:${replyId}`;

// ---------- storage ----------

async function schema() {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_social_drafts (
    id bigserial PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES insights_accounts (id) ON DELETE CASCADE,
    channel text NOT NULL DEFAULT 'threads',
    kind text NOT NULL,
    topic text NOT NULL,
    source_url text NOT NULL,
    link text NOT NULL,
    body text NOT NULL,
    checked text NOT NULL DEFAULT 'owner',
    status text NOT NULL DEFAULT 'draft',
    reason text,
    post_id text,
    permalink text,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
  )`;
  await sql`CREATE INDEX IF NOT EXISTS insights_social_drafts_account ON insights_social_drafts (account_id, created_at DESC)`;
  // One row per reply and site: the primary key is what makes sure nothing is answered twice.
  await sql`CREATE TABLE IF NOT EXISTS insights_threads_replies (
    account_id bigint NOT NULL REFERENCES insights_accounts (id) ON DELETE CASCADE,
    reply_id text NOT NULL,
    media_id text NOT NULL,
    username text NOT NULL DEFAULT '',
    text text NOT NULL DEFAULT '',
    replied_at timestamptz,
    status text NOT NULL DEFAULT 'new',
    answer text,
    checked text,
    health boolean NOT NULL DEFAULT false,
    reason text,
    answer_id text,
    drafted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    PRIMARY KEY (account_id, reply_id)
  )`;
  // Answers that went out (or may have) each day, raised in one atomic step that refuses once the cap is reached.
  await sql`CREATE TABLE IF NOT EXISTS insights_threads_reply_daily (
    account_id bigint NOT NULL,
    day date NOT NULL,
    n integer NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  )`;
}

/** An answer claimed for posting that Threads never confirmed within an hour: shown to the owner as failed, never sent again blindly. */
export const STUCK_REASON = "Threads never confirmed this answer, so it may or may not be live. Check your Threads profile before answering again.";
async function expireStuck(accountId: string): Promise<void> {
  await sql`
    UPDATE insights_threads_replies SET status = 'failed', reason = ${STUCK_REASON}
    WHERE account_id = ${accountId} AND status = 'posting' AND decided_at < now() - interval '1 hour'`;
}

export interface SocialDraft {
  id: string;
  kind: SocialKind;
  topic: string;
  sourceUrl: string;
  link: string;
  text: string;
  checked: "ai" | "owner";
  status: "draft" | "posted" | "skipped" | "held" | "failed";
  reason: string | null;
  permalink: string | null;
  at: string;
}

export interface ReplyDraft {
  replyId: string;
  username: string;
  question: string;
  answer: string | null;
  checked: "ai" | "owner" | null;
  health: boolean;
  status: "draft" | "posted" | "skipped" | "held" | "failed" | "ignored" | "new";
  reason: string | null;
  at: string;
}

const toDraft = (r: Record<string, unknown>): SocialDraft => ({
  id: String(r.id),
  kind: (SOCIAL_KINDS.includes(r.kind as SocialKind) ? r.kind : "tip") as SocialKind,
  topic: String(r.topic),
  sourceUrl: String(r.source_url),
  link: String(r.link),
  text: String(r.body),
  checked: r.checked === "ai" ? "ai" : "owner",
  status: String(r.status) as SocialDraft["status"],
  reason: r.reason ? String(r.reason) : null,
  permalink: r.permalink ? String(r.permalink) : null,
  at: new Date(String(r.created_at)).toISOString(),
});

const toReply = (r: Record<string, unknown>): ReplyDraft => ({
  replyId: String(r.reply_id),
  username: String(r.username ?? ""),
  question: String(r.text ?? ""),
  answer: r.answer ? String(r.answer) : null,
  checked: r.checked === "ai" ? "ai" : r.checked === "owner" ? "owner" : null,
  health: yes(r.health),
  status: String(r.status) as ReplyDraft["status"],
  reason: r.reason ? String(r.reason) : null,
  at: new Date(String(r.created_at)).toISOString(),
});

/** The site's drafts and recent decisions, newest first. */
export async function socialDrafts(accountId: string): Promise<{ posts: SocialDraft[]; replies: ReplyDraft[] }> {
  await schema();
  await expireStuck(accountId);
  const posts = await sql`SELECT * FROM insights_social_drafts WHERE account_id = ${accountId} AND channel = 'threads' AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 20`;
  const replies = await sql`
    SELECT * FROM insights_threads_replies WHERE account_id = ${accountId} AND status IN ('draft', 'held', 'posted', 'failed') AND created_at > now() - interval '14 days'
    ORDER BY created_at DESC LIMIT 30`;
  return { posts: posts.map(toDraft), replies: replies.map(toReply) };
}

// ---------- the site's own pages and searches ----------

/** The site's own pages the agent may post about: its read pages and the autopilot's own published articles. */
async function sourcePages(accountId: string, domain: string | null): Promise<SourcePage[]> {
  const host = domain?.replace(/^www\./, "").toLowerCase() ?? null;
  const own = (u: string) => {
    try {
      const h = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
      return !host || h === host;
    } catch {
      return false;
    }
  };
  const read = (await sitePages(accountId)).filter((p) => own(p.url));
  const pages: SourcePage[] = read.map((p) => ({ url: p.url, title: p.h1 || p.title, text: p.text, article: isPostUrl(p.url) }));
  const seen = new Set(pages.map((p) => normUrl(p.url)));
  const rows = await sql`
    SELECT page_url, after_value FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied', 'kept') AND note LIKE 'Published%'
      AND reverted_at IS NULL AND page_url LIKE 'http%'
    ORDER BY created_at DESC LIMIT 30`.catch(() => []);
  for (const r of rows) {
    const url = String(r.page_url);
    if (seen.has(normUrl(url)) || !own(url)) continue;
    const a = articleFromLog(String(r.after_value ?? ""));
    if (a.title) pages.push({ url, title: a.title, text: a.text, article: true });
    seen.add(normUrl(url));
  }
  return pages;
}

/** What people search now for this site: its own Search Console searches, and Keyword Planner volumes already cached for it. */
async function siteDemand(accountId: string): Promise<Demand[]> {
  const out: Demand[] = [];
  const conn = await getConnection(accountId).catch(() => null);
  if (conn?.gscSiteUrl) {
    try {
      for (const r of await querySearches28d(conn)) out.push({ query: r.query, page: r.page, weight: r.impressions });
    } catch (e) {
      // Search Console has its own checks; the post still works from Keyword Planner and the site's pages.
      console.warn(`social agent: search console not read for account ${accountId}: ${(e as Error).message}`);
    }
  }
  for (const k of await readSiteKeywords(accountId).catch(() => [])) out.push({ query: k.keyword, page: k.page, weight: k.monthlySearches / 10 });
  return out;
}

/**
 * Which of the top searches people ask about on Threads right now: counts of public posts with a question, only when
 * this connection was given keyword search. Nobody's words are kept or passed on.
 */
async function askedOnThreads(accountId: string, link: ThreadsLink, queries: string[]): Promise<Map<string, number>> {
  const asked = new Map<string, number>();
  if (!hasScope(link, "threads_keyword_search", false)) return asked;
  for (const q of queries.slice(0, 3)) {
    try {
      const texts = await keywordSearch(link, q);
      asked.set(q, texts.filter((t) => t.includes("?")).length);
    } catch (e) {
      if (lacksPermission(e)) {
        await dropThreadsScope(accountId, "threads_keyword_search").catch(() => undefined);
        return asked;
      }
      console.warn(`social agent: threads search failed for account ${accountId}: ${(e as Error).message}`);
      return asked;
    }
  }
  return asked;
}

async function aiFor(profile: Profile): Promise<AiProvider | null> {
  const base = aiProvider(await readPlatformSettings());
  return base ? { ...base, site: siteBrief(profile) } : null;
}

const keepNames = (profile: Profile) => [profile.brandName, profile.siteDomain].filter((x): x is string => Boolean(x && x.trim()));

// ---------- posts ----------

/** Posts made in the last seven days plus drafts waiting: a new draft is only worth it while the week has room. */
async function weekIsFull(accountId: string): Promise<boolean> {
  const [posted] = await sql`SELECT count(*) AS n FROM insights_threads_posts WHERE account_id = ${accountId} AND posted_at > now() - interval '7 days'`;
  const [waiting] = await sql`SELECT count(*) AS n FROM insights_social_drafts WHERE account_id = ${accountId} AND channel = 'threads' AND status = 'draft'`;
  return Number(posted?.n ?? 0) + Number(waiting?.n ?? 0) >= WEEKLY_POST_CAP;
}

/** Drafts the next educational post, and posts it when the owner turned on automatic posting. Returns a line for the log. */
export async function draftNextPost(accountId: string, link: ThreadsLink, failures: string[] = []): Promise<string | null> {
  await schema();
  if (await weekIsFull(accountId)) return null;
  const profile = await readProfile(accountId);
  const health = healthRulesApply(profile);
  const pages = await sourcePages(accountId, profile.siteDomain);
  if (!pages.length) return "No pages of the site have been read yet, so there is nothing to post about.";
  const [last] = await sql`SELECT kind FROM insights_social_drafts WHERE account_id = ${accountId} AND channel = 'threads' ORDER BY created_at DESC LIMIT 1`;
  const kind = nextKind(last?.kind ? String(last.kind) : null);
  const used = await sql`SELECT source_url FROM insights_social_drafts WHERE account_id = ${accountId} AND created_at > now() - interval '21 days'`;
  const recent = new Set(used.map((r) => normUrl(String(r.source_url))));
  let demand = await siteDemand(accountId);
  const top = [...new Set(demand.filter((d) => !d.page || !recent.has(normUrl(d.page))).map((d) => d.query))].slice(0, 3);
  const asked = await askedOnThreads(accountId, link, top);
  demand = demand.map((d) => ({ ...d, asked: asked.get(d.query) ?? 0 }));
  const pick = pickTopic(pages, demand, recent, kind, profile.brandName);
  if (!pick) return "Every page was posted about lately; the next post waits for a new page.";
  const ai = await aiFor(profile);
  if (!ai) return "No AI key, so no post was written.";
  const url = pickLink(pick.page, findSignupPage(pages.map((p) => p.url)));
  const raw = await writeSocialPost(ai, {
    kind,
    topic: pick.query,
    title: pick.page.title,
    text: pick.page.text,
    brand: profile.brandName,
    site: profile.siteDomain ?? "this site",
    health,
    room: roomFor(url),
  });
  const clean = cleanPost(raw, keepNames(profile), roomFor(url), health);
  let status: SocialDraft["status"] = "draft";
  let reason: string | null = clean.problem;
  let checked: "ai" | "owner" = "owner";
  if (reason) status = "held";
  else {
    const verdict = await secondCheck(ai, { what: "a short educational social post", source: `${pick.page.title}\n${pick.page.text}`, text: clean.text, health });
    if (verdict && !verdict.ok) {
      status = "held";
      reason = `The second AI turned it down: ${verdict.why || "no reason given."}`;
    } else if (verdict) checked = "ai";
    else reason = "No second AI was free to check it, so it waits for your approval.";
  }
  const [row] = await sql`
    INSERT INTO insights_social_drafts (account_id, channel, kind, topic, source_url, link, body, checked, status, reason)
    VALUES (${accountId}, 'threads', ${kind}, ${pick.query}, ${pick.page.url}, ${url}, ${clean.text || raw.slice(0, 500)}, ${checked}, ${status}, ${reason})
    RETURNING id`;
  if (status === "held") return `A Threads post about "${pick.query}" was held back: ${reason}`;
  if (link.auto && checked === "ai") {
    const out = await approvePost(accountId, String(row.id), null, "autopilot");
    // The cap or a post already made is no failure; anything else stays visible to the Inspector.
    if (!out.ok && out.status !== 429 && out.status !== 409) failures.push(`Automatic post: ${out.error}`);
    return out.ok ? `Posted a ${kind} about "${pick.query}" to Threads.` : `A Threads post about "${pick.query}" waits: ${out.error}`;
  }
  return `Drafted a Threads ${kind} about "${pick.query}" for your approval.`;
}

type Outcome = { ok: true; permalink: string | null } | { ok: false; error: string; status: number };

/** Validates the owner's own edit the same way: the claim guard, no dashes, within the limit. */
function ownerEdit(text: string, link: string | null, health: boolean): { text: string; problem: string | null } {
  const t = noDashes(text.replace(/https?:\/\/\S+/g, " ").replace(/[ \t]+/g, " ").trim());
  if (!t) return { text: "", problem: "Write something first." };
  const room = link ? roomFor(link) : THREADS_MAX_CHARS;
  if (t.length > room) return { text: t, problem: `Keep it under ${room} characters.` };
  return { text: t, problem: claimProblem(t, health) };
}

/** Posts a draft (the owner's Approve, or automatic posting): within the weekly cap, once only. */
export async function approvePost(accountId: string, id: string, edited: string | null, by: "owner" | "autopilot"): Promise<Outcome> {
  await schema();
  const [row] = await sql`SELECT * FROM insights_social_drafts WHERE account_id = ${accountId} AND id = ${id} AND channel = 'threads'`;
  if (!row) return { ok: false, status: 404, error: "That draft isn't on the list anymore." };
  if (row.status !== "draft") return { ok: false, status: 409, error: row.status === "posted" ? "This is already on Threads." : "This draft can't be posted." };
  let body = String(row.body);
  if (edited !== null) {
    const health = healthRulesApply(await readProfile(accountId));
    const e = ownerEdit(edited, String(row.link), health);
    if (e.problem) return { ok: false, status: 400, error: e.problem };
    body = e.text;
    await sql`UPDATE insights_social_drafts SET body = ${body}, checked = 'owner' WHERE id = ${id}`;
  }
  const out = await postThreadsText(accountId, `social:${id}`, composePost(body, String(row.link)), by);
  if (out.ok) {
    await sql`UPDATE insights_social_drafts SET status = 'posted', post_id = ${out.post.postId}, permalink = ${out.post.permalink}, reason = NULL, decided_at = now() WHERE id = ${id}`;
    return { ok: true, permalink: out.post.permalink };
  }
  // Threads may have it live: it isn't offered again.
  if (/may have been posted/.test(out.error)) await sql`UPDATE insights_social_drafts SET status = 'failed', reason = ${out.error}, decided_at = now() WHERE id = ${id}`;
  else await sql`UPDATE insights_social_drafts SET reason = ${out.error} WHERE id = ${id}`;
  return out;
}

export async function skipPost(accountId: string, id: string): Promise<void> {
  await schema();
  await sql`UPDATE insights_social_drafts SET status = 'skipped', decided_at = now() WHERE account_id = ${accountId} AND id = ${id} AND status IN ('draft', 'held', 'failed')`;
}

// ---------- replies ----------

/** Answers drafted or posted today for this site. */
async function repliesToday(accountId: string): Promise<number> {
  const [r] = await sql`
    SELECT count(*) AS n FROM insights_threads_replies
    WHERE account_id = ${accountId} AND drafted_at > now() - interval '1 day'`;
  return Number(r?.n ?? 0);
}

/** The site's page that best fits a reply: most words in common with it, among the pages the posts came from first. */
function bestPage(pages: SourcePage[], text: string, preferred: Set<string>): SourcePage | null {
  const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  let best: { p: SourcePage; s: number } | null = null;
  for (const p of pages) {
    const hay = `${p.title} ${p.text.slice(0, 3000)}`.toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s++;
    if (preferred.has(normUrl(p.url))) s += 1;
    if (s > 0 && (!best || s > best.s)) best = { p, s };
  }
  return best?.p ?? null;
}

/** Reads replies to the site's recent posts, skips what isn't worth answering, and drafts helpful answers. */
export async function handleReplies(accountId: string, link: ThreadsLink, failures: string[] = []): Promise<string | null> {
  await schema();
  await expireStuck(accountId);
  if (!hasScope(link, "threads_read_replies", true)) return "Connect Threads again so replies can be read.";
  const posts = await sql`
    SELECT p.post_id, d.source_url FROM insights_threads_posts p
    LEFT JOIN insights_social_drafts d ON p.change_id = 'social:' || d.id::text
    WHERE p.account_id = ${accountId} AND p.post_id IS NOT NULL AND p.posted_at > now() - interval '14 days'
    ORDER BY p.posted_at DESC LIMIT 5`;
  if (!posts.length) return null;
  const profile = await readProfile(accountId);
  const healthSite = healthRulesApply(profile);
  const fresh: { id: string; text: string; username: string }[] = [];
  for (const p of posts) {
    let replies;
    try {
      replies = await fetchReplies(link, String(p.post_id));
    } catch (e) {
      if (needsReconnect(e)) {
        await noteError(accountId, "Threads needs to be connected again.");
        return "Threads needs to be connected again to read replies.";
      }
      if (lacksPermission(e)) {
        await dropThreadsScope(accountId, "threads_read_replies").catch(() => undefined);
        failures.push(`Reading replies: ${(e as Error).message}`);
        return "Threads didn't allow reading replies.";
      }
      throw e;
    }
    for (const r of replies) {
      const c = classifyReply(r.text, r.username, link.username);
      const health = isHealthQuestion(r.text, healthSite, c.kind);
      // Stored first, so a reply is looked at once only, whatever happens next.
      const [ins] = await sql`
        INSERT INTO insights_threads_replies (account_id, reply_id, media_id, username, text, replied_at, status, health, reason)
        VALUES (${accountId}, ${r.id}, ${String(p.post_id)}, ${r.username}, ${r.text.slice(0, 2000)}, ${r.timestamp || null}, ${c.kind === "skip" ? "ignored" : "new"}, ${health}, ${c.reason})
        ON CONFLICT (account_id, reply_id) DO NOTHING RETURNING reply_id`;
      if (ins && c.kind !== "skip") fresh.push({ id: r.id, text: r.text, username: r.username });
    }
  }
  // Earlier replies that weren't drafted yet (the daily cap was used) come first.
  const waiting = await sql`SELECT reply_id, text, username, health FROM insights_threads_replies WHERE account_id = ${accountId} AND status = 'new' ORDER BY created_at LIMIT 20`;
  let room = REPLY_DAILY_CAP - (await repliesToday(accountId));
  if (room <= 0 || !waiting.length) return fresh.length ? `${fresh.length} new ${fresh.length === 1 ? "reply" : "replies"} wait for tomorrow's answers.` : null;
  const ai = await aiFor(profile);
  if (!ai) return "No AI key, so no answers were written.";
  const pages = await sourcePages(accountId, profile.siteDomain);
  const preferred = new Set(posts.map((p) => (p.source_url ? normUrl(String(p.source_url)) : "")).filter(Boolean));
  let drafted = 0;
  let posted = 0;
  for (const w of waiting) {
    if (room <= 0) break;
    room--;
    const replyId = String(w.reply_id);
    const health = yes(w.health);
    const page = bestPage(pages, String(w.text), preferred);
    if (!page) {
      await sql`UPDATE insights_threads_replies SET status = 'ignored', reason = 'None of the site''s pages covers it.' WHERE account_id = ${accountId} AND reply_id = ${replyId}`;
      continue;
    }
    const answer = await draftAnswer(ai, profile, healthSite, health, String(w.text), page);
    await sql`
      UPDATE insights_threads_replies SET status = ${answer.status}, answer = ${answer.text}, checked = ${answer.checked}, reason = ${answer.reason}, drafted_at = now()
      WHERE account_id = ${accountId} AND reply_id = ${replyId}`;
    drafted++;
    if (answer.status === "draft" && answer.checked === "ai" && link.autoReply) {
      const out = await approveReply(accountId, replyId, null, "autopilot");
      if (out.ok) posted++;
      else if (out.status !== 429 && out.status !== 409) failures.push(`Automatic answer: ${out.error}`);
    }
  }
  if (!drafted) return null;
  return posted ? `Answered ${posted} of ${drafted} replies on Threads.` : `Drafted ${drafted} ${drafted === 1 ? "answer" : "answers"} to Threads replies for your approval.`;
}

async function draftAnswer(
  ai: AiProvider,
  profile: Profile,
  healthSite: boolean,
  healthQuestion: boolean,
  question: string,
  page: SourcePage,
): Promise<{ text: string; status: "draft" | "held"; checked: "ai" | "owner"; reason: string | null }> {
  const strict = healthSite || healthQuestion;
  const room = THREADS_MAX_CHARS - (healthQuestion ? DOCTOR_LINE.length + 1 : 0);
  const raw = await writeReplyAnswer(ai, { reply: question, title: page.title, text: page.text, brand: profile.brandName, site: profile.siteDomain ?? "this site", health: strict, room });
  const clean = cleanPost(raw, keepNames(profile), room, strict);
  if (clean.problem) return { text: clean.text || raw.slice(0, 500), status: "held", checked: "owner", reason: clean.problem };
  const text = healthQuestion ? withDoctorLine(clean.text) : clean.text;
  const verdict = await secondCheck(ai, { what: "an answer to a public reply", publicText: question, source: `${page.title}\n${page.text}`, text, health: strict });
  if (verdict && !verdict.ok) return { text, status: "held", checked: "owner", reason: `The second AI turned it down: ${verdict.why || "no reason given."}` };
  return { text, status: "draft", checked: verdict ? "ai" : "owner", reason: verdict ? null : "No second AI was free to check it, so it waits for your approval." };
}

/** Posts an answer (the owner's Approve, or automatic replies): once only, within the daily cap. */
export async function approveReply(accountId: string, replyId: string, edited: string | null, by: "owner" | "autopilot"): Promise<Outcome> {
  await schema();
  const [row] = await sql`SELECT * FROM insights_threads_replies WHERE account_id = ${accountId} AND reply_id = ${replyId}`;
  if (!row || !row.answer) return { ok: false, status: 404, error: "That answer isn't on the list anymore." };
  if (row.status !== "draft") return { ok: false, status: 409, error: row.status === "posted" ? "This reply was already answered." : "This answer can't be posted." };
  const health = yes(row.health);
  let text = String(row.answer);
  if (edited !== null) {
    const profile = await readProfile(accountId);
    const e = ownerEdit(edited, null, healthRulesApply(profile) || health);
    if (e.problem) return { ok: false, status: 400, error: e.problem };
    text = health ? withDoctorLine(e.text) : e.text;
  }
  const link = await freshLink(accountId);
  if (!link || Date.parse(link.expiresAt) <= Date.now()) return { ok: false, status: 400, error: "Connect Threads again first." };
  // Claimed in one step: two clicks can't answer twice.
  const [claim] = await sql`
    UPDATE insights_threads_replies SET status = 'posting', answer = ${text}, checked = ${edited !== null ? "owner" : row.checked}, decided_at = now()
    WHERE account_id = ${accountId} AND reply_id = ${replyId} AND status = 'draft'
    RETURNING reply_id`;
  if (!claim) return { ok: false, status: 409, error: "This answer is already being posted." };
  // Then one of today's answers, in one atomic step that refuses at the cap (an answer that may be live keeps its count).
  const [count] = await sql`
    INSERT INTO insights_threads_reply_daily (account_id, day, n) VALUES (${accountId}, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (account_id, day) DO UPDATE SET n = insights_threads_reply_daily.n + 1 WHERE insights_threads_reply_daily.n < ${REPLY_DAILY_CAP}
    RETURNING n`;
  const giveBack = async () => {
    await sql`UPDATE insights_threads_reply_daily SET n = greatest(n - 1, 0) WHERE account_id = ${accountId} AND day = (now() AT TIME ZONE 'UTC')::date`.catch(() => undefined);
  };
  if (!count?.n) {
    await sql`UPDATE insights_threads_replies SET status = 'draft', decided_at = NULL WHERE account_id = ${accountId} AND reply_id = ${replyId} AND status = 'posting'`;
    return { ok: false, status: 429, error: `${REPLY_DAILY_CAP} answers went out today, the most allowed. Try again tomorrow.` };
  }
  try {
    const out = await publishReply(link, replyId, text);
    await sql`UPDATE insights_threads_replies SET status = 'posted', answer_id = ${out.id}, reason = NULL, decided_at = now() WHERE account_id = ${accountId} AND reply_id = ${replyId}`;
    void report("threads", true);
    return { ok: true, permalink: out.permalink };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof UnclearPublish) {
      await sql`UPDATE insights_threads_replies SET status = 'failed', reason = ${msg}, decided_at = now() WHERE account_id = ${accountId} AND reply_id = ${replyId}`;
      return { ok: false, status: 502, error: msg };
    }
    // Threads clearly refused: nothing is live, so the answer and today's count are free again.
    await sql`UPDATE insights_threads_replies SET status = 'draft', reason = ${msg}, decided_at = NULL WHERE account_id = ${accountId} AND reply_id = ${replyId}`;
    await giveBack();
    if (needsReconnect(e)) {
      await noteError(accountId, "Threads needs to be connected again.");
      return { ok: false, status: 502, error: "Threads needs to be connected again. Nothing was posted." };
    }
    console.error(`threads answer failed for account ${accountId}: ${msg}`);
    void report("threads", false, `Answering a reply: ${msg}`);
    return { ok: false, status: 502, error: `Threads didn't post it. Nothing was posted. ${msg}` };
  }
}

export async function skipReply(accountId: string, replyId: string): Promise<void> {
  await schema();
  await sql`UPDATE insights_threads_replies SET status = 'skipped', decided_at = now() WHERE account_id = ${accountId} AND reply_id = ${replyId} AND status IN ('draft', 'held', 'new', 'failed')`;
}

// ---------- the daily run ----------

/** Sites with Threads connected whose daily social run is due (at most once a day each). */
export async function accountsDueForSocial(limit: number): Promise<string[]> {
  await schema();
  await threadsSchema();
  // Only sites whose autopilot is on: a paused site gets no drafts, posts or answers.
  const rows = await sql`
    SELECT t.account_id FROM insights_account_threads t
    JOIN insights_account_autopilot a ON a.account_id = t.account_id
    WHERE a.enabled AND t.expires_at > now() AND (t.social_at IS NULL OR t.social_at < now() - interval '22 hours')
    ORDER BY t.social_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** The daily social run for one site: a post draft (or post), then replies. Never during the Sabbath. */
export async function runSocialAgent(accountId: string): Promise<string> {
  if (isSabbath()) return "rests for the Sabbath";
  await schema();
  await sql`UPDATE insights_account_threads SET social_at = now() WHERE account_id = ${accountId}`;
  // Checked again here: the owner may have paused the autopilot since the list was made. Paused means nothing at all
  // runs, automatic posts and answers included.
  if (!(await readAccountAutopilot(accountId)).enabled) return "the autopilot is paused";
  const link = await freshLink(accountId);
  if (!link || Date.parse(link.expiresAt) <= Date.now()) return "Threads isn't connected";
  const notes: string[] = [];
  const failures: string[] = [];
  for (const step of [() => draftNextPost(accountId, link, failures), () => handleReplies(accountId, link, failures)]) {
    try {
      const n = await step();
      if (n) notes.push(n);
    } catch (e) {
      const msg = (e as Error).message;
      failures.push(msg);
      notes.push(`failed: ${msg}`);
      console.error(`social agent failed for account ${accountId}: ${msg}`);
    }
  }
  // A failure anywhere in the run stays on the status board for the Inspector. A run is never reported as working on its
  // own: only a real post to Threads clears the board, so one site's quiet day can't hide another site's failure.
  if (failures.length) void report("threads", false, `Social agent: ${failures.join(" ")}`);
  return notes.join(" ") || "nothing to do today";
}
