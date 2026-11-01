import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { bestPageForTopic } from "../seo-tools";
import { readProspects, upsertProspects, type Prospect } from "./backlinks";
import { otherClient } from "./clients";
import { topicWords } from "./site-keywords";

/**
 * The Broken Link Agent. Once a week it reads the health resource pages the
 * backlink finder found, checks the links on them, and when one is dead (the
 * page is gone: 404 or 410, or its whole domain no longer exists) it finds
 * this site's own page on that topic that already does best on Google. That
 * becomes a backlink prospect with a ready email: "your link to X is broken,
 * here's a working page on the same subject". The owner sends it.
 *
 * Careful by design: a link only counts as broken on a clear signal, never on
 * a timeout or a site that blocks checks (403, 429), and only links that look
 * like content (not social profiles or the page's own site) are checked.
 */

const KEY = (accountId: string) => `brokenlinks:${accountId}`;
/** Resource pages read per week, links checked per page, and in total. */
const PAGES = 6;
const LINKS_PER_PAGE = 40;
const MAX_CHECKS = 150;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; DashPatrolLinkCheck/1.0)", Accept: "text/html,*/*" };

/** Accounts with the autopilot on whose weekly broken link check is due. */
export async function accountsDueForBrokenLinks(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'brokenlinks:' || a.account_id
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

async function markChecked(accountId: string, note: string): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify({ at: new Date().toISOString(), note })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
}

const SKIP_LINKS =
  /(^|\.)(facebook|instagram|twitter|x|tiktok|linkedin|pinterest|youtube|reddit|google|apple|amazon|bit\.ly|t\.co|wa\.me|mailto)\b/i;

/** External content links on a page, with their link text. */
function linksOn(html: string, pageUrl: string, ourDomain: string): { href: string; anchor: string }[] {
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(m[1], pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const host = url.hostname.replace(/^www\./, "");
    if (host === pageHost || host === ourDomain || host.endsWith(`.${ourDomain}`) || SKIP_LINKS.test(host)) continue;
    // A link to a site's home page isn't a page about a topic: nothing to replace it with.
    if (url.pathname === "/" || url.pathname === "") continue;
    const anchor = m[2].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (anchor.length < 4 || anchor.length > 120) continue;
    if (!out.has(url.href)) out.set(url.href, anchor);
  }
  return [...out].slice(0, LINKS_PER_PAGE).map(([href, anchor]) => ({ href, anchor }));
}

/** True only on a clear sign the page is gone: 404 or 410, or a domain that doesn't exist any more. */
async function isDead(href: string): Promise<boolean> {
  const tryFetch = (method: "HEAD" | "GET") =>
    fetch(href, { method, headers: UA, redirect: "follow", signal: AbortSignal.timeout(7000) });
  try {
    let res = await tryFetch("HEAD");
    // Some sites don't answer HEAD properly: ask again with GET before judging.
    if (res.status === 405 || res.status === 501 || res.status === 403) res = await tryFetch("GET");
    return res.status === 404 || res.status === 410;
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
    // The domain itself doesn't resolve any more. Timeouts and resets don't count.
    return code === "ENOTFOUND";
  }
}

export async function runBrokenLinks(accountId: string, conn: Connection | null, ourDomain: string): Promise<string> {
  const list = await readProspects(accountId);
  const sources = (list?.prospects ?? [])
    .filter((p) => (p.kind === "resource" || p.kind === "guest") && p.status === "new")
    .sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0))
    .slice(0, PAGES);
  if (!sources.length || !conn?.gscSiteUrl) {
    await markChecked(accountId, sources.length ? "no Search Console to pick a replacement page" : "no resource pages yet");
    return sources.length ? "no Search Console" : "no resource pages yet";
  }
  const isOther = await otherClient(ourDomain);
  const found: Prospect[] = [];
  let checks = 0;

  for (const page of sources) {
    if (checks >= MAX_CHECKS) break;
    const res = await fetch(page.url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(9000) }).catch(() => null);
    if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("html")) continue;
    const html = (await res.text().catch(() => "")).slice(0, 2_000_000);
    const links = linksOn(html, page.url, ourDomain).filter((l) => !isOther(new URL(l.href).hostname)).slice(0, MAX_CHECKS - checks);
    checks += links.length;
    // A few at a time, to stay polite.
    const dead: typeof links = [];
    for (let i = 0; i < links.length; i += 8) {
      const batch = links.slice(i, i + 8);
      const results = await Promise.all(batch.map((l) => isDead(l.href)));
      batch.forEach((l, j) => results[j] && dead.push(l));
    }
    // The first dead link we can offer a real replacement for (this site's best page on its subject).
    for (const d of dead) {
      const words = [...topicWords(`${d.anchor} ${decodeURIComponent(new URL(d.href).pathname).replace(/[-_/]+/g, " ")}`)].slice(0, 4);
      const best =
        (words.length ? await bestPageForTopic(conn, words).catch(() => null) : null) ??
        (await bestPageForTopic(conn, [...topicWords(page.topic)]).catch(() => null));
      if (!best) continue;
      found.push({ ...page, kind: "broken", brokenLink: d.href, anchor: d.anchor, ourPage: best.page, foundAt: new Date().toISOString() });
      break;
    }
  }
  if (found.length) await upsertProspects(accountId, found);
  const note = `${found.length} broken ${found.length === 1 ? "link" : "links"} found on ${sources.length} pages (${checks} links checked)`;
  await markChecked(accountId, note);
  return note;
}
