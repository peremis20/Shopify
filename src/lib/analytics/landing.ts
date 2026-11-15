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

/** Product forms, sizes and packaging: they describe how a product comes, not which product it is. */
const FORM = new Set(
  "capsule capsul tablet softgel gummy gummie powder liquid drop oil cream lotion tea bag bottle jar pack count ct mg mcg g kg oz ml l lb size original new formula supplement".split(" "),
);

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

/** A page's own topic: its address, main heading and title (without the brand part after a separator). */
export function pageTopic(c: Pick<LandingCandidate, "url" | "title" | "h1">, brand: Set<string>): Set<string> {
  let slug = "";
  try {
    slug = decodeURIComponent(new URL(c.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "");
  } catch {
    slug = "";
  }
  const title = c.title.split(/\s+[|–—-]\s+/)[0] ?? "";
  const all = topicTerms(`${slug} ${c.h1 ?? ""} ${title}`);
  for (const b of brand) all.delete(b);
  return all;
}

/**
 * Whether a page is exactly about the topic: every meaning word of the topic is in the page's own topic, and the page
 * adds no word that names another product or variant (for a product page any extra word, sizes and forms aside; for a
 * landing page any word that names one of the site's products).
 */
export function matchesTopic(topic: string, c: LandingCandidate, productWords: Set<string>, brand: Set<string>): boolean {
  const want = topicTerms(topic);
  for (const b of brand) want.delete(b);
  if (!want.size) return false;
  const own = pageTopic(c, brand);
  for (const w of want) if (!own.has(w)) return false;
  for (const w of own) {
    if (want.has(w) || FORM.has(w) || /^\d+$/.test(w)) continue;
    if (c.kind === "product" || productWords.has(w)) return false;
  }
  return true;
}

export interface LandingPick {
  /** The page to send people to, or null for the article. */
  url: string | null;
  /** Matching pages left out because their own text has risky wording, with that wording. */
  blocked: { url: string; phrases: string[] }[];
}

/**
 * The landing or product page for a topic, when one matches exactly and passes the claim guard. Products first (the
 * most direct page), then landing pages, each with the fewest extra words first.
 */
export function pickLanding(topic: string, candidates: LandingCandidate[], brandName: string | null | undefined): LandingPick {
  const brand = topicTerms(brandName ?? "");
  const productWords = new Set<string>();
  for (const c of candidates) if (c.kind === "product") for (const w of pageTopic(c, brand)) if (!FORM.has(w)) productWords.add(w);
  const matches = candidates
    .filter((c) => matchesTopic(topic, c, productWords, brand))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "product" ? -1 : 1) || pageTopic(a, brand).size - pageTopic(b, brand).size || a.url.length - b.url.length);
  const blocked: LandingPick["blocked"] = [];
  for (const c of matches) {
    const flags = scanClaims(`${c.title}. ${c.h1 ?? ""}. ${c.text}`);
    if (flags.length) {
      blocked.push({ url: c.url, phrases: [...new Set(flags.map((f) => f.phrase))].slice(0, 5) });
      continue;
    }
    return { url: c.url, blocked };
  }
  return { url: null, blocked };
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

/** Keeps the latest note per page (newest first, at most ten), so the owner sees what to fix. */
async function saveNotes(accountId: string, blocked: LandingPick["blocked"]): Promise<void> {
  if (!blocked.length) return;
  const cur = await landingNotes(accountId);
  const at = new Date().toISOString();
  const next = [...blocked.map((b) => ({ ...b, at })), ...cur.filter((n) => !blocked.some((b) => b.url === n.url))].slice(0, 10);
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
export async function landingFor(accountId: string, topic: string, articleUrl: string, brand: string | null | undefined): Promise<string> {
  try {
    const host = new URL(articleUrl).hostname;
    const pick = pickLanding(topic, await candidatesFor(accountId, host), brand);
    await saveNotes(accountId, pick.blocked).catch((e) => console.error(`landing notes not saved for account ${accountId}: ${(e as Error).message}`));
    return pick.url ?? articleUrl;
  } catch (e) {
    console.warn(`landing page not chosen for account ${accountId}: ${(e as Error).message}`);
    return articleUrl;
  }
}

/** The search an autopilot article was written for (its topic), or the given fallback (its title). */
export async function articleTopic(accountId: string, changeId: string, fallback: string): Promise<string> {
  if (!/^\d+$/.test(changeId)) return fallback;
  const [row] = await sql`SELECT query FROM insights_autopilot_changes WHERE account_id = ${accountId} AND id = ${changeId}`.catch(() => []);
  const q = row?.query ? String(row.query).trim() : "";
  return q || fallback;
}
