import { ensureSchema, sql } from "../db";
import { parsePage, sitemapUrls } from "../site-crawl";
import { readCapped, safeFetch } from "./broken-links";

/**
 * The Site Auditor: reads every page in the site's sitemap once a week, the way Google does, and lists every problem
 * it finds. What a content change can fix (a missing or duplicate title or description, a thin article, images with no
 * description) goes to the autopilot, which fixes it with the usual checks (site-audit app). What only a person can fix
 * (a page that errors, a page hidden from Google, a canonical pointing elsewhere, no main heading) is shown to the owner.
 * Only the site's own public pages are read.
 */

export interface AuditIssue {
  code: string;
  level: "high" | "medium" | "low";
  text: string;
  /** True when the autopilot can fix it with a content change. */
  auto: boolean;
  /** Seen on two checks in a row: only confirmed problems are fixed or shown, so one bad read never acts. */
  confirmed?: boolean;
}

export interface AuditedPage {
  url: string;
  status: number | null;
  title: string | null;
  description: string | null;
  issues: AuditIssue[];
  checkedAt: string;
}

/** Pages read per site per hour, so a large site is covered within the week without a long run. */
const PAGES_PER_PASS = 25;
const WEEK_MS = 7 * 864e5;

const words = (t: string) => (t.match(/\b[\p{L}\p{N}']+\b/gu) ?? []).length;
const norm = (t: string | null) => (t ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** A single article (not a blog's own listing, tag or page list): Shopify's /blogs/<blog>/<post>, or /blog/<post> elsewhere. */
export const isArticle = (url: string) => {
  const path = new URL(url).pathname.replace(/\/$/, "");
  if (/\/(tagged|tag|tags|category|categories|page|author)(\/|$)/i.test(path)) return false;
  return /^\/blogs\/[^/]+\/[^/]+$/i.test(path) || /\/(blog|news|articles?|posts?|journal|insights|resources|learn)\/[^/]+$/i.test(path);
};

/** Sites with autopilot on that have pages due for an audit. */
export async function accountsDueForAudit(limit: number): Promise<{ accountId: string; domain: string }[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id, p.site_domain FROM insights_account_autopilot a
    JOIN insights_account_profile p ON p.account_id = a.account_id
    LEFT JOIN insights_settings s ON s.key = 'audit_pass:' || a.account_id
    WHERE a.enabled AND coalesce(p.site_domain, '') <> '' AND (s.updated_at IS NULL OR s.updated_at < now() - interval '1 hour')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => ({ accountId: String(r.account_id), domain: String(r.site_domain) }));
}

/** The problems on one page, before the checks that compare pages with each other. */
export function pageIssues(url: string, status: number, html: string): { title: string | null; description: string | null; issues: AuditIssue[] } {
  const issues: AuditIssue[] = [];
  if (status >= 400 || !html) {
    issues.push({ code: "error", level: "high", text: `The page doesn't load (${status || "no answer"}), but the sitemap lists it.`, auto: false });
    return { title: null, description: null, issues };
  }
  const p = parsePage(url, html);
  const title = p.title.trim() || null;
  const description = p.metaDescription?.trim() || null;
  if (p.noindex) issues.push({ code: "noindex", level: "high", text: "Hidden from Google: the page tells search engines not to index it, but the sitemap lists it.", auto: false });
  if (p.canonical) {
    try {
      const c = new URL(p.canonical, url);
      const here = new URL(url);
      if (c.pathname.replace(/\/$/, "") !== here.pathname.replace(/\/$/, "") || c.hostname.replace(/^www\./, "") !== here.hostname.replace(/^www\./, ""))
        issues.push({ code: "canonical", level: "medium", text: `Points Google to another page as the main version (${c.pathname}), so this one may not show.`, auto: false });
    } catch {
      /* an unreadable canonical is ignored */
    }
  }
  if (!title) issues.push({ code: "title-missing", level: "high", text: "No page title for Google to show.", auto: true });
  else if (title.length > 70) issues.push({ code: "title-long", level: "low", text: `The title is ${title.length} characters, so Google cuts it short.`, auto: true });
  else if (title.length < 15) issues.push({ code: "title-short", level: "medium", text: "The title is too short to tell searchers what the page is.", auto: true });
  if (!description) issues.push({ code: "description-missing", level: "medium", text: "No meta description, so Google picks its own snippet.", auto: true });
  if (!p.h1) issues.push({ code: "h1-missing", level: "medium", text: "No main heading (H1) on the page.", auto: false });
  if (isArticle(url) && words(p.text) < 300)
    issues.push({ code: "thin", level: "medium", text: `Only about ${words(p.text)} words, which Google often treats as thin.`, auto: true });
  const imgs = [...p.mainHtml.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  // Only images with no alt attribute at all: alt="" marks a decorative image on purpose. Shown for information only:
  // the writer can describe only images it can edit, so this alone never sends a page to the autopilot.
  const noAlt = imgs.filter((i) => !/\balt\s*=/i.test(i)).length;
  if (noAlt) issues.push({ code: "alt", level: "low", text: `${noAlt} ${noAlt === 1 ? "image has" : "images have"} no description (alt text).`, auto: false });
  return { title, description, issues };
}

/** One pass: reads the site's due pages (new ones first, then the oldest), then marks titles and descriptions used twice. */
export async function auditPass(accountId: string, domain: string, deadline = Date.now() + 90_000): Promise<string> {
  await ensureSchema();
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`audit_pass:${accountId}`}, ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  // The sitemap is read once a day (it can be slow), not every pass.
  const urlKey = `audit_urls:${accountId}`;
  const [cachedUrls] = await sql`SELECT value FROM insights_settings WHERE key = ${urlKey} AND updated_at > now() - interval '1 day'`.catch(() => [] as { value: string | null }[]);
  let urls: string[] = cachedUrls?.value ? (JSON.parse(cachedUrls.value) as string[]) : [];
  if (!urls.length) {
    urls = await sitemapUrls(`https://${domain}`);
    if (!urls.length) urls.push(`https://${domain}/`);
    await sql`INSERT INTO insights_settings (key, value) VALUES (${urlKey}, ${JSON.stringify(urls)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
  }
  const previous = await sql`SELECT url, checked_at, issues FROM insights_site_audit WHERE account_id = ${accountId}`;
  const known = new Map(previous.map((r) => [String(r.url), Date.parse(String(r.checked_at))]));
  const before = new Map(
    previous.map((r) => [String(r.url), new Set(((typeof r.issues === "string" ? JSON.parse(r.issues) : r.issues) as AuditIssue[]).map((i) => i.code))]),
  );
  const due = urls
    .filter((u) => !known.has(u) || Date.now() - known.get(u)! > WEEK_MS)
    .sort((a, b) => (known.get(a) ?? 0) - (known.get(b) ?? 0))
    .slice(0, PAGES_PER_PASS);
  let read = 0;
  // A page that couldn't be read this time keeps what was found before and is tried again in a day, so it never
  // takes a slot every pass and holds up the rest of the site.
  const later = (url: string) =>
    sql`INSERT INTO insights_site_audit (account_id, url, issues, checked_at) VALUES (${accountId}, ${url}, '[]'::jsonb, now() - interval '6 days')
      ON CONFLICT (account_id, url) DO UPDATE SET checked_at = now() - interval '6 days'`.catch(() => undefined);
  for (let i = 0; i < due.length && Date.now() < deadline; i += 5) {
    await Promise.all(
      due.slice(i, i + 5).map(async (url) => {
        const res = await safeFetch(url, "GET", 12_000).catch(() => null);
        if (!res || res === "unresolved") return void (await later(url)); // not reachable right now: never reported from one miss
        const status = res.status;
        // A busy or failing server (429, 5xx) is retried next pass, not reported as a broken page.
        if (status === 429 || status >= 500) {
          await res.body?.cancel().catch(() => undefined);
          return void (await later(url));
        }
        const html = res.ok && /html/i.test(res.headers.get("content-type") ?? "html") ? await readCapped(res, 2_000_000).catch(() => "") : "";
        if (!html) await res.body?.cancel().catch(() => undefined);
        // A page that isn't HTML (a PDF, an image) is skipped.
        if (res.ok && !html) return void (await later(url));
        const r = pageIssues(url, status, html);
        // The second look: a problem found on the last check too is confirmed.
        const seen = before.get(url);
        r.issues = r.issues.map((i) => ({ ...i, confirmed: Boolean(seen?.has(i.code)) }));
        await sql`
          INSERT INTO insights_site_audit (account_id, url, status, title, description, issues, checked_at)
          VALUES (${accountId}, ${url}, ${status || null}, ${r.title}, ${r.description}, ${JSON.stringify(r.issues)}::jsonb, now())
          ON CONFLICT (account_id, url) DO UPDATE SET status = EXCLUDED.status, title = EXCLUDED.title, description = EXCLUDED.description,
            issues = EXCLUDED.issues, checked_at = now()`.catch((e) => console.error(`audit couldn't save ${url}: ${(e as Error).message}`));
        read++;
      }),
    );
  }
  // Pages gone from the sitemap are forgotten.
  if (urls.length > 1) {
    const keep = new Set(urls);
    for (const u of known.keys()) if (!keep.has(u)) await sql`DELETE FROM insights_site_audit WHERE account_id = ${accountId} AND url = ${u}`;
  }
  await markDuplicates(accountId);
  return `${read} ${read === 1 ? "page" : "pages"} checked`;
}

/** Titles and descriptions that more than one page uses: Google can't tell those pages apart. */
async function markDuplicates(accountId: string): Promise<void> {
  const rows = await sql`SELECT url, title, description, issues FROM insights_site_audit WHERE account_id = ${accountId}`;
  const count = (key: "title" | "description") => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = norm(r[key] as string | null);
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return m;
  };
  const titles = count("title");
  const descs = count("description");
  for (const r of rows) {
    const before = (typeof r.issues === "string" ? JSON.parse(r.issues) : r.issues) as AuditIssue[];
    const issues = before.filter((i) => i.code !== "title-dup" && i.code !== "description-dup");
    const t = norm(r.title as string | null);
    const d = norm(r.description as string | null);
    const had = (code: string) => before.some((i) => i.code === code);
    if (t && (titles.get(t) ?? 0) > 1) issues.push({ code: "title-dup", level: "medium", text: `${titles.get(t)! - 1} other ${titles.get(t)! - 1 === 1 ? "page has" : "pages have"} the same title.`, auto: true, confirmed: had("title-dup") });
    if (d && (descs.get(d) ?? 0) > 1) issues.push({ code: "description-dup", level: "medium", text: `${descs.get(d)! - 1} other ${descs.get(d)! - 1 === 1 ? "page has" : "pages have"} the same meta description.`, auto: true, confirmed: had("description-dup") });
    if (JSON.stringify(issues) !== JSON.stringify(before))
      await sql`UPDATE insights_site_audit SET issues = ${JSON.stringify(issues)}::jsonb WHERE account_id = ${accountId} AND url = ${r.url}`;
  }
}

export async function readAudit(accountId: string): Promise<AuditedPage[]> {
  await ensureSchema();
  const rows = await sql`SELECT url, status, title, description, issues, checked_at FROM insights_site_audit WHERE account_id = ${accountId} ORDER BY url`;
  return rows.map((r) => ({
    url: String(r.url),
    status: r.status === null ? null : Number(r.status),
    title: r.title,
    description: r.description,
    issues: (typeof r.issues === "string" ? JSON.parse(r.issues) : r.issues) as AuditIssue[],
    checkedAt: String(r.checked_at),
  }));
}
