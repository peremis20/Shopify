import { ensureSchema, sql } from "../db";
import { getBody, setBody } from "./shopify";
import { siteFor } from "./site-source";

/**
 * Expert review: the site's reviewer (a clinician on a health site, any qualified expert elsewhere) and the articles
 * the app wrote that are waiting for them. An article shows "Reviewed by" only after the owner marks it reviewed,
 * once their expert has really read it: the app never claims a review that didn't happen.
 */
export interface Reviewer {
  name: string;
  /** Short credentials, e.g. "RD, MS" or "MD, board certified in family medicine". */
  credentials: string;
  /** A public profile page about them (optional). */
  url: string | null;
}

export interface ReviewItem {
  resourceId: string;
  url: string;
  search: string;
  postedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

const REVIEWER = (id: string) => `expert_reviewer:${id}`;
const REVIEWS = (id: string) => `expert_reviews:${id}`;

async function readJson<T>(key: string): Promise<T | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key}`;
  return row?.value ? (JSON.parse(row.value) as T) : null;
}
async function writeJson(key: string, value: unknown): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key}, ${JSON.stringify(value)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const readReviewer = (accountId: string) => readJson<Reviewer>(REVIEWER(accountId));

export async function saveReviewer(accountId: string, r: { name?: unknown; credentials?: unknown; url?: unknown }): Promise<Reviewer> {
  const name = String(r.name ?? "").trim().slice(0, 80);
  const credentials = String(r.credentials ?? "").trim().slice(0, 120);
  const rawUrl = String(r.url ?? "").trim();
  if (name.length < 3) throw new Error("Add the reviewer's full name.");
  if (!credentials) throw new Error("Add the reviewer's credentials, for example RD or MD.");
  let url: string | null = null;
  if (rawUrl) {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") throw new Error("The profile link must start with https://");
    url = u.toString();
  }
  const reviewer = { name, credentials, url };
  await writeJson(REVIEWER(accountId), reviewer);
  return reviewer;
}

/** The app's articles on this site, with whether each has been reviewed. */
export async function reviewList(accountId: string): Promise<ReviewItem[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT DISTINCT ON (resource_id) resource_id, page_url, query, created_at FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied', 'kept') AND resource_type = 'article'
    ORDER BY resource_id, created_at DESC`;
  const marks = (await readJson<Record<string, { at: string; by: string }>>(REVIEWS(accountId))) ?? {};
  return rows
    .map((r) => ({
      resourceId: String(r.resource_id),
      url: String(r.page_url),
      search: String(r.query),
      postedAt: String(r.created_at),
      reviewedAt: marks[String(r.resource_id)]?.at ?? null,
      reviewedBy: marks[String(r.resource_id)]?.by ?? null,
    }))
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const START = "<!-- dashpatrol:reviewed -->";
const END = "<!-- /dashpatrol:reviewed -->";

/** The byline placed at the top of a reviewed article (kept apart so it can be tested). */
export function reviewedByline(r: Reviewer, on: Date): string {
  const date = on.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const who = r.url ? `<a href="${esc(r.url)}" rel="noopener">${esc(r.name)}</a>` : esc(r.name);
  return `${START}<p><em>Reviewed by ${who}, ${esc(r.credentials)}, on ${date}.</em></p>${END}`;
}

/** Puts the byline at the top of the body, replacing an earlier one. */
export function withByline(body: string, byline: string): string {
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  const rest = s !== -1 && e > s ? body.slice(0, s) + body.slice(e + END.length) : body;
  return `${byline}\n${rest.replace(/^\s+/, "")}`;
}

/** The owner confirms their expert read this article: the byline goes on it (Shopify), and it's recorded. */
export async function markReviewed(accountId: string, resourceId: string): Promise<ReviewItem[]> {
  const reviewer = await readReviewer(accountId);
  if (!reviewer) throw new Error("Add your reviewer's name and credentials first.");
  const item = (await reviewList(accountId)).find((i) => i.resourceId === resourceId);
  if (!item) throw new Error("That article isn't one the app wrote on this site.");
  const site = await siteFor(accountId);
  if (!site?.store) throw new Error("The byline can be added automatically on Shopify only. Add it by hand on this site.");
  const body = await getBody(site.store, "article", resourceId);
  await setBody(site.store, "article", resourceId, withByline(body, reviewedByline(reviewer, new Date())));
  const marks = (await readJson<Record<string, { at: string; by: string }>>(REVIEWS(accountId))) ?? {};
  marks[resourceId] = { at: new Date().toISOString(), by: `${reviewer.name}, ${reviewer.credentials}` };
  await writeJson(REVIEWS(accountId), marks);
  return reviewList(accountId);
}
