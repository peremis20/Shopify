import { ensureSchema, sql } from "./db";
import { PLATFORM_LABEL, type Platform } from "./fix-guides";

/**
 * Reads any website the way a search engine does: its sitemap, then each
 * page's title, meta description, headings, main text and links. This is how
 * the app works for sites it can't edit directly (WordPress, Wix,
 * Squarespace, Webflow, AI builders, custom code): the autopilot plans
 * against these pages and hands the owner a fix list, and the weekly claim
 * and overlap checks read them. Pages are rechecked about once a week.
 */

export { PLATFORM_LABEL, type Platform };

/** What a page's HTML says it was built with. */
export function detectPlatform(html: string): Platform {
  const h = html.slice(0, 200_000);
  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(h)?.[1]?.toLowerCase() ?? "";
  if (/cdn\.shopify\.com|Shopify\.theme/.test(h)) return "shopify";
  if (gen.includes("wordpress") || /\/wp-content\/|\/wp-includes\//.test(h)) return "wordpress";
  if (gen.includes("wix") || /static\.wixstatic\.com|wix-bolt|_wixCssImports/.test(h)) return "wix";
  if (gen.includes("squarespace") || /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/.test(h)) return "squarespace";
  if (gen.includes("webflow") || /data-wf-site|assets\.website-files\.com|cdn\.prod\.website-files\.com/.test(h)) return "webflow";
  if (gen.includes("framer") || /framerusercontent\.com|framer\.com\/m\//.test(h)) return "framer";
  if (/img\d*\.wsimg\.com|godaddy/i.test(h)) return "godaddy";
  if (/irp\.cdn-website\.com|dmAlbum|duda/i.test(h)) return "duda";
  if (gen.includes("weebly") || /editmysite\.com/.test(h)) return "weebly";
  if (gen.includes("ghost")) return "ghost";
  if (/hs-scripts\.com|hubspot/i.test(h) && /hs-sites|hubfs/.test(h)) return "hubspot";
  return "custom";
}

const UA = "Mozilla/5.0 (compatible; SiteReader/1.0; +https://search.google.com)";

async function get(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; status: number; text: string; url: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml;q=0.9,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "", url: res.url || url };
  } catch {
    return { ok: false, status: 0, text: "", url };
  }
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    // Numeric entities, like &#8211; for a dash.
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();

/** Page addresses from the site's sitemaps (robots.txt, then the usual places), same site only, sitemap indexes followed. */
export async function sitemapUrls(origin: string, max = 300): Promise<string[]> {
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const robots = await get(`${origin}/robots.txt`, 8000);
  const declared = [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const queue = [...new Set([...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])];
  const seen = new Set<string>();
  const pages = new Set<string>();
  while (queue.length && seen.size < 40 && pages.size < max) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await get(sm, 10_000);
    if (!res.ok || !/<(urlset|sitemapindex)/i.test(res.text)) continue;
    const locs = [...res.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => decode(m[1]));
    if (/<sitemapindex/i.test(res.text)) {
      queue.push(...locs);
      continue;
    }
    for (const loc of locs) {
      try {
        const u = new URL(loc);
        if (u.hostname.replace(/^www\./, "") !== host) continue;
        if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|xml)$/i.test(u.pathname)) continue;
        u.hash = "";
        pages.add(u.toString());
      } catch {
        /* not an address */
      }
      if (pages.size >= max) break;
    }
  }
  return [...pages];
}

export interface ParsedPage {
  url: string;
  title: string;
  metaDescription: string | null;
  canonical: string | null;
  noindex: boolean;
  h1: string | null;
  /** The page's main content as HTML, without header, navigation, footer, scripts or styles. */
  mainHtml: string;
  text: string;
  schemaTypes: string[];
  siteName: string | null;
  publishedAt: string | null;
  image: string | null;
  /** The FDA supplement disclaimer appears anywhere on the page (footer included). */
  disclaimer: boolean;
}

const attr = (html: string, re: RegExp) => {
  const m = re.exec(html);
  return m ? decode(m[1]) : null;
};

export const toText = (html: string) =>
  decode(html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parsePage(url: string, rawHtml: string): ParsedPage {
  // Null characters break Postgres text columns; some pages contain them.
  const html = rawHtml.replace(/\u0000/g, "");
  const head = html.slice(0, Math.max(html.search(/<body/i), 0) || 60_000);
  const meta = (name: string) =>
    attr(head, new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`, "i")) ??
    attr(head, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i"));
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // The main content: <main> or <article> when the site marks it, otherwise the body without its header, nav and footer.
  const main =
    /<main[\s\S]*?>([\s\S]*?)<\/main>/i.exec(body)?.[1] ??
    /<article[\s\S]*?>([\s\S]*?)<\/article>/i.exec(body)?.[1] ??
    body.replace(/<(header|nav|footer|aside)[\s\S]*?<\/\1>/gi, " ");
  const schemaTypes = [...html.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  return {
    url,
    title: decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ""),
    metaDescription: meta("description"),
    canonical: attr(head, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i),
    noindex: /noindex/i.test(meta("robots") ?? ""),
    h1: (() => {
      const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
      return m ? toText(m[1]) : null;
    })(),
    mainHtml: main.replace(/\s+/g, " ").trim().slice(0, 40_000),
    text: toText(main).slice(0, 20_000),
    schemaTypes: [...new Set(schemaTypes)],
    siteName: meta("og:site_name"),
    publishedAt: meta("article:published_time"),
    image: meta("og:image"),
    disclaimer: /not been evaluated by the food and drug administration/i.test(toText(html)),
  };
}

export interface SitePage extends ParsedPage {
  status: number;
  fetchedAt: string;
}

/** Fetches and stores the pages due for a read (new ones first, then the oldest), a few at a time. Returns how many were read. */
export async function crawlSite(accountId: string, domain: string, budget = 60): Promise<{ read: number; platform: Platform | null }> {
  await ensureSchema();
  const origin = `https://${domain}`;
  const urls = await sitemapUrls(origin);
  // A site with no sitemap still has a home page.
  if (!urls.length) urls.push(`${origin}/`);
  const known = new Map(
    (await sql`SELECT url, fetched_at FROM insights_site_pages WHERE account_id = ${accountId}`).map((r) => [r.url!, new Date(r.fetched_at!).getTime()])
  );
  const weekAgo = Date.now() - 7 * 864e5;
  const due = urls.filter((u) => !known.has(u) || known.get(u)! < weekAgo).sort((a, b) => (known.get(a) ?? 0) - (known.get(b) ?? 0)).slice(0, budget);

  let platform: Platform | null = null;
  let read = 0;
  for (let i = 0; i < due.length; i += 6) {
    await Promise.all(
      due.slice(i, i + 6).map(async (url) => {
        const res = await get(url);
        if (!res.ok || !res.text) {
          await sql`
            INSERT INTO insights_site_pages (account_id, url, status, fetched_at) VALUES (${accountId}, ${url}, ${res.status}, now())
            ON CONFLICT (account_id, url) DO UPDATE SET status = EXCLUDED.status, fetched_at = now()`;
          return;
        }
        if (!platform) platform = detectPlatform(res.text);
        const p = parsePage(url, res.text);
        // One page that can't be saved never stops the others.
        await sql`
          INSERT INTO insights_site_pages (account_id, url, status, title, meta_description, h1, main_html, text, data, fetched_at)
          VALUES (${accountId}, ${url}, ${res.status}, ${p.title}, ${p.metaDescription}, ${p.h1}, ${p.mainHtml}, ${p.text},
            ${JSON.stringify({ canonical: p.canonical, noindex: p.noindex, schemaTypes: p.schemaTypes, siteName: p.siteName, publishedAt: p.publishedAt, image: p.image, disclaimer: p.disclaimer })}::jsonb, now())
          ON CONFLICT (account_id, url) DO UPDATE SET status = EXCLUDED.status, title = EXCLUDED.title, meta_description = EXCLUDED.meta_description,
            h1 = EXCLUDED.h1, main_html = EXCLUDED.main_html, text = EXCLUDED.text, data = EXCLUDED.data, fetched_at = now()`.catch((e) =>
          console.error(`couldn't save ${url}: ${(e as Error).message}`)
        );
        read++;
      })
    );
  }
  // Pages gone from the sitemap are forgotten.
  if (urls.length > 1) {
    const keep = new Set(urls);
    for (const u of known.keys()) if (!keep.has(u)) await sql`DELETE FROM insights_site_pages WHERE account_id = ${accountId} AND url = ${u}`;
  }
  return { read, platform };
}

/** The stored pages of a site that loaded fine (main HTML only when asked for; it's the heavy part). */
export async function sitePages(accountId: string, withHtml = false): Promise<SitePage[]> {
  await ensureSchema();
  const rows = withHtml
    ? await sql`SELECT * FROM insights_site_pages WHERE account_id = ${accountId} AND status = 200 ORDER BY url`
    : await sql`SELECT url, title, meta_description, h1, text, data, status, fetched_at FROM insights_site_pages WHERE account_id = ${accountId} AND status = 200 ORDER BY url`;
  return rows.map((r) => {
    const d = (typeof r.data === "string" ? JSON.parse(r.data) : r.data ?? {}) as Partial<ParsedPage>;
    return {
      url: r.url!,
      title: r.title ?? "",
      metaDescription: r.meta_description,
      h1: r.h1,
      mainHtml: r.main_html ?? "",
      text: r.text ?? "",
      canonical: d.canonical ?? null,
      noindex: Boolean(d.noindex),
      schemaTypes: d.schemaTypes ?? [],
      siteName: d.siteName ?? null,
      publishedAt: d.publishedAt ?? null,
      image: d.image ?? null,
      disclaimer: Boolean(d.disclaimer),
      status: Number(r.status),
      fetchedAt: r.fetched_at!,
    };
  });
}

/** One page, from the store of read pages or read now. */
export async function sitePage(accountId: string, url: string): Promise<SitePage | null> {
  const norm = (u: string) => u.replace(/\/$/, "").replace(/^https?:\/\/www\./, "https://").replace(/^http:/, "https:");
  const hit = (await sitePages(accountId, true)).find((p) => norm(p.url) === norm(url));
  if (hit) return hit;
  const res = await get(url);
  if (!res.ok || !res.text) return null;
  return { ...parsePage(url, res.text), status: res.status, fetchedAt: new Date().toISOString() };
}

/** Blog posts look like this on most platforms. */
export const isPostUrl = (url: string) => /\/(blog|blogs|news|articles?|posts?|journal|insights|resources|learn)\/[^/]+/i.test(new URL(url).pathname);
