import { ensureSchema, sql } from "./db";
import { sitePages } from "./site-crawl";
import { scanClaims } from "./autopilot/claims";
import { GLUE, stem } from "./autopilot/backlinks";

/**
 * Where a social post sends people: the site's own landing page or product page when its topic is exactly the post's
 * topic, otherwise the article. Generic for any site: candidates are only the site's own read pages, on its own domain.
 *
 * Exact means every meaning word of the post's topic is in the page's own topic (its address, main heading and title),
 * compared the same way as the backlink topics (glue words out, simple stems). A page whose own topic adds another
 * product or variant word is never used: a magnesium threonate post never goes to a glycinate page, and a glycinate
 * post never goes to a page about a glycinate and threonate blend.
 *
 * Before a page is promoted, its own text goes through the claim guard. A page with risky wording is never linked; the
 * article is used and the owner gets a note listing the wording to fix.
 */

export interface LandingCandidate {
  url: string;
  title: string;
  h1: string | null;
  text: string;
  kind: "landing" | "product";
}

/** Sizes and counts: they say how much, not which product. */
const SIZE = new Set("count ct mg mcg g kg oz ml l lb pack size".split(" "));
/** Product forms: another form is another product, unless the post names that form too. */
const FORM = new Set("capsule tablet softgel gummy gummie powder liquid drop oil cream lotion spray tea bar chew chewable serum balm".split(" ").map(stem));
/** Words that join two things ("threonate with glycinate"): with one between two words the page is about more than the post. */
const JOIN = new Set(["and", "or", "with", "plus", "+"]);
/** Words that combine or compare products: a page with one is about more than the post's topic. */
const COMBO = new Set("blend blends complex combo combination combinations vs versus plus stack mix".split(" "));
/** General words a landing page may add next to the topic without naming another product or variant. */
const GENERAL = new Set("best top guide benefit tip fact faq natural daily simple complete ultimate easy info learn more shop buy new official review".split(" ").map(stem));

/** The site's landing and product pages by their address (or null for any other page). */
export function pageKind(url: string): LandingCandidate["kind"] | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\/(?:products?|shop\/p)\/[^/]+\/?$/.test(path)) return "product";
  if (/\/(?:pages|landing|lp)\/[^/]+\/?$/.test(path)) return "landing";
  return null;
}

/** The meaning words of a phrase: lower case, glue words out, stemmed (the backlink topics' way). */
export function topicTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !GLUE.has(w))
      .map(stem),
  );
}

/** The words of a phrase in order: glue words kept as they are (they break adjacency), the rest stemmed; "&" reads as "and". */
function sequence(text: string): { raw: string; term: string }[] {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((raw) => ({ raw, term: GLUE.has(raw) ? raw : stem(raw) }));
}

/** The slug, main heading and title (without the brand part after a separator) of a page, each as a word sequence. */
function pageSequences(c: Pick<LandingCandidate, "url" | "title" | "h1">): { raw: string; term: string }[][] {
  let slug = "";
  try {
    slug = decodeURIComponent(new URL(c.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "");
  } catch {
    slug = "";
  }
  const title = c.title.split(/\s+[|\u2013\u2014-]\s+/)[0] ?? "";
  return [sequence(slug.replace(/[-_]+/g, " ")), sequence(c.h1 ?? ""), sequence(title)];
}

/** A page's own topic: the meaning words of its address, main heading and title, brand words out. */
export function pageTopic(c: Pick<LandingCandidate, "url" | "title" | "h1">, brand: Set<string>): Set<string> {
  const all = new Set<string>();
  for (const seq of pageSequences(c)) for (const t of seq) if (t.raw.length > 1 && !GLUE.has(t.raw) && !brand.has(t.term)) all.add(t.term);
  return all;
}

/** Words that sit right next to a topic word in the site's own searches ("magnesium threonate"): variants of it. */
export function searchVariants(searches: string[], want: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const q of searches) {
    const seq = sequence(q);
    seq.forEach((t, i) => {
      if (!want.has(t.term)) return;
      for (const n of [seq[i - 1], seq[i + 1]]) if (n && !GLUE.has(n.raw) && !want.has(n.term) && !/^\d+$/.test(n.term)) out.add(n.term);
    });
  }
  return out;
}

export interface MatchContext {
  /** Every word in the names of the site's own products. */
  productWords: Set<string>;
  /** Words next to a topic word in the site's own searches. */
  variants: Set<string>;
  brand: Set<string>;
}

/**
 * Whether a page is exactly about the topic: every meaning word of the topic is in the page's own topic, and nothing
 * in the page's topic names another product or variant. A page is out when it joins or compares products (blend, vs,
 * plus, "and" between product words), has another form (oil, gummies) the post doesn't name, or adds a word that sits
 * right next to a topic word, names one of the site's products, or is a variant in the site's own searches. A product
 * page adds no word at all but sizes and counts. General words (best, guide, sleep) are fine on a landing page.
 */
export function matchesTopic(topic: string, c: LandingCandidate, ctx: MatchContext): boolean {
  const want = topicTerms(topic);
  for (const b of ctx.brand) want.delete(b);
  if (!want.size) return false;
  const own = pageTopic(c, ctx.brand);
  for (const w of want) if (!own.has(w)) return false;
  const seqs = pageSequences(c);
  const named = (term: string) => want.has(term) || ctx.productWords.has(term) || ctx.variants.has(term) || FORM.has(term);
  for (const seq of seqs) {
    for (const [i, t] of seq.entries()) {
      if (COMBO.has(t.raw)) return false;
      // "and", "or", "with" between two words: a page about two things ("threonate with glycinate").
      if (JOIN.has(t.raw) && seq[i - 1] && seq[i + 1] && !GLUE.has(seq[i - 1].raw) && !GLUE.has(seq[i + 1].raw)) {
        const other = [seq[i - 1], seq[i + 1]].find((n) => !want.has(n.term));
        if (named(seq[i - 1].term) && named(seq[i + 1].term)) return false;
        if (other && (named(other.term) || !GENERAL.has(other.term))) return false;
      }
    }
  }
  for (const w of own) {
    if (want.has(w) || SIZE.has(w) || /^\d+$/.test(w)) continue;
    if (FORM.has(w) || c.kind === "product" || ctx.productWords.has(w)) return false;
    if (ctx.variants.has(w)) return false;
    if (GENERAL.has(w)) continue;
    // Right next to a topic word ("magnesium glycinate" for a magnesium post): it narrows the topic to a variant.
    if (seqs.some((seq) => seq.some((t, i) => t.term === w && [seq[i - 1], seq[i + 1]].some((n) => n && want.has(n.term))))) return false;
  }
  return true;
}

export interface LandingPick {
  /** The page to send people to, or null for the article. */
  page: LandingCandidate | null;
  /** Matching pages left out because their own text has risky wording, with that wording. */
  blocked: { url: string; phrases: string[] }[];
}

const claimText = (c: LandingCandidate) => `${c.title}. ${c.h1 ?? ""}. ${c.text}`;

/**
 * The landing or product page for a topic, when one matches exactly and passes the claim guard. Products first (the
 * most direct page), then landing pages, each with the fewest extra words first. `searches` are the site's own.
 */
export function pickLanding(topic: string, candidates: LandingCandidate[], brandName: string | null | undefined, searches: string[] = []): LandingPick {
  const brand = topicTerms(brandName ?? "");
  const productWords = new Set<string>();
  for (const c of candidates) if (c.kind === "product") for (const w of pageTopic(c, brand)) if (!SIZE.has(w) && !/^\d+$/.test(w)) productWords.add(w);
  const want = topicTerms(topic);
  const ctx: MatchContext = { productWords, variants: searchVariants(searches, want), brand };
  const matches = candidates
    .filter((c) => matchesTopic(topic, c, ctx))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "product" ? -1 : 1) || pageTopic(a, brand).size - pageTopic(b, brand).size || a.url.length - b.url.length);
  const blocked: LandingPick["blocked"] = [];
  for (const c of matches) {
    const flags = scanClaims(claimText(c));
    if (flags.length) {
      blocked.push({ url: c.url, phrases: [...new Set(flags.map((f) => f.phrase))].slice(0, 5) });
      continue;
    }
    return { page: c, blocked };
  }
  return { page: null, blocked };
}

/**
 * The owner's notes after a pick: a page no longer read from the site, or whose own text now passes the claim guard,
 * is dropped; the rest keep their current wording; new ones come first. At most ten.
 */
export function refreshNotes(cur: LandingNote[], blocked: LandingPick["blocked"], candidates: LandingCandidate[], at: string): LandingNote[] {
  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  const kept: LandingNote[] = [];
  for (const n of cur) {
    if (blocked.some((b) => b.url === n.url)) continue;
    const c = byUrl.get(n.url);
    if (!c) continue;
    const phrases = [...new Set(scanClaims(claimText(c)).map((f) => f.phrase))].slice(0, 5);
    if (phrases.length) kept.push({ ...n, phrases });
  }
  return [...blocked.map((b) => ({ ...b, at })), ...kept].slice(0, 10);
}

// ---------- the site's own pages, and notes for the owner ----------

const notesKey = (accountId: string) => `landing_notes:${accountId}`;

export interface LandingNote {
  url: string;
  phrases: string[];
  at: string;
}

export async function landingNotes(accountId: string): Promise<LandingNote[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${notesKey(accountId)}`;
  try {
    const v = row?.value ? JSON.parse(String(row.value)) : [];
    return Array.isArray(v) ? (v as LandingNote[]) : [];
  } catch {
    return [];
  }
}

/** Saves the owner's notes after a pick, clearing the ones that no longer apply. */
async function saveNotes(accountId: string, blocked: LandingPick["blocked"], candidates: LandingCandidate[]): Promise<void> {
  const cur = await landingNotes(accountId);
  const next = refreshNotes(cur, blocked, candidates, new Date().toISOString());
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${notesKey(accountId)}, ${JSON.stringify(next)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The site's own landing and product pages that loaded fine, on the same domain as the article. */
async function candidatesFor(accountId: string, host: string): Promise<LandingCandidate[]> {
  const bare = host.replace(/^www\./, "").toLowerCase();
  const out: LandingCandidate[] = [];
  for (const p of await sitePages(accountId)) {
    let h: string;
    try {
      h = new URL(p.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    const kind = pageKind(p.url);
    if (h !== bare || !kind || p.noindex) continue;
    out.push({ url: p.url, title: p.title, h1: p.h1, text: p.text, kind });
  }
  return out;
}

/**
 * Where a post about this topic should send people: a matching landing or product page of the site, or the article.
 * Risky pages are noted for the owner. Never fails the post: on any problem it is the article.
 */
export async function landingFor(
  accountId: string,
  topic: string,
  articleUrl: string,
  brand: string | null | undefined,
  searches: string[] = [],
): Promise<LandingCandidate | null> {
  try {
    const candidates = await candidatesFor(accountId, new URL(articleUrl).hostname);
    const pick = pickLanding(topic, candidates, brand, searches);
    await saveNotes(accountId, pick.blocked, candidates).catch((e) => console.error(`landing notes not saved for account ${accountId}: ${(e as Error).message}`));
    return pick.page;
  } catch (e) {
    console.warn(`landing page not chosen for account ${accountId}: ${(e as Error).message}`);
    return null;
  }
}

/** Text that talks about the article itself ("read the full article"): it may only link to that article. */
export const mentionsArticle = (text: string) =>
  /\b(?:article|blog|post|read (?:more|the|our|it)|full (?:guide|story)|this guide|our guide|write ?up)\b/i.test(text);
