import { sql } from "../db";
import { readCapped, safeFetch } from "./broken-links";

/**
 * The contact email a site shows publicly, for the owner's backlink outreach: read from the prospect page itself, then
 * the site's home, contact and about pages. Only addresses printed on the site count (never a guessed info@), and the
 * site's own domain is preferred. A public fact about a public site, so it is kept for 30 days in the shared cache.
 */
const PAGES = ["", "/contact", "/contact-us", "/about", "/about-us", "/write-for-us"];
const NOT_PEOPLE = /^(no-?reply|donotreply|mailer-daemon|postmaster|abuse|privacy|dmca|legal|unsubscribe)@/i;
const NOT_EMAILS = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|sentry|wixpress|domain|email)\.|@\d+x\./i;

export async function findContactEmail(pageUrl: string, domain: string): Promise<string | null> {
  const d = domain.toLowerCase().replace(/^www\./, "");
  const key = `contact:${d}`;
  const [hit] = await sql`SELECT data FROM insights_report_cache WHERE cache_key = ${key} AND fetched_at > now() - interval '30 days'`.catch(() => [] as { data: unknown }[]);
  if (hit?.data) {
    const v = typeof hit.data === "string" ? JSON.parse(hit.data) : hit.data;
    return (v as { email: string | null }).email ?? null;
  }
  const found = new Map<string, number>();
  const urls = [pageUrl, ...PAGES.map((p) => `https://${d}${p}`)];
  for (const href of urls) {
    const res = await safeFetch(href, "GET", 7000).catch(() => null);
    if (!res || res === "unresolved" || !res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) continue;
    const html = (await readCapped(res, 400_000).catch(() => "")).replace(/&#64;|&#x40;|\s*(\[at\]|\(at\))\s*/gi, "@");
    for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      const e = m[0].toLowerCase().replace(/\.$/, "");
      if (NOT_PEOPLE.test(e) || NOT_EMAILS.test(e)) continue;
      const own = e.endsWith(`@${d}`) || e.endsWith(`.${d}`);
      found.set(e, (found.get(e) ?? 0) + (own ? 10 : 1) + (/mailto:/i.test(html.slice(Math.max(0, m.index! - 8), m.index)) ? 5 : 0));
    }
    if ([...found.keys()].some((e) => e.endsWith(`@${d}`))) break;
  }
  const email = [...found.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${key}, ${JSON.stringify({ email })}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return email;
}
