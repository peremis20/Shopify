import { sql } from "../db";
import { readCapped, safeFetch } from "./broken-links";

/**
 * The contact email a site shows publicly, for the owner's backlink outreach: read from the prospect page itself, then
 * the site's home, contact and about pages. Only addresses printed on the site count (never a guessed info@), and the
 * site's own domain is preferred. A public fact about a public site, so it is kept for 30 days in the shared cache.
 */
const PAGES = ["", "/contact", "/contact-us", "/pages/contact", "/about", "/about-us", "/write-for-us", "/contribute", "/advertise", "/team", "/privacy-policy", "/privacy"];

/** Cloudflare hides printed addresses as data-cfemail="hex" (a one byte key, then the address XORed with it). */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

/** Text with the usual ways sites hide a printed address turned back into plain addresses. */
export function revealEmails(html: string): string {
  return html
    .replace(/data-cfemail="([0-9a-f]+)"/gi, (_m, hex: string) => ` ${decodeCfEmail(hex) ?? ""} `)
    .replace(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi, (_m, hex: string) => ` ${decodeCfEmail(hex) ?? ""} `)
    .replace(/&#64;|&#x40;|\s*(\[at\]|\(at\)|\{at\}| at )\s*(?=[a-z0-9-]+(\s*(\[dot\]|\(dot\)|\.| dot )\s*)[a-z]{2,})/gi, "@")
    .replace(/\s*(\[dot\]|\(dot\)|\{dot\})\s*/gi, ".");
}
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
  // One overall deadline, so a slow site can't hold up writing the email.
  const deadline = Date.now() + 12_000;
  let loaded = 0;
  for (const href of urls) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    const res = await safeFetch(href, "GET", Math.min(5000, left)).catch(() => null);
    if (!res || res === "unresolved" || !res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) continue;
    loaded++;
    const html = revealEmails(await readCapped(res, 400_000).catch(() => ""));
    for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      const e = m[0].toLowerCase().replace(/\.$/, "");
      if (NOT_PEOPLE.test(e) || NOT_EMAILS.test(e)) continue;
      const root = d.split(".").slice(-2).join(".");
      const own = e.endsWith(`@${d}`) || e.endsWith(`.${d}`) || e.endsWith(`@${root}`);
      found.set(e, (found.get(e) ?? 0) + (own ? 10 : 1) + (/mailto:/i.test(html.slice(Math.max(0, m.index! - 8), m.index)) ? 5 : 0));
    }
    if ([...found.keys()].some((e) => e.endsWith(`@${d}`))) break;
  }
  const email = [...found.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // "No email on the site" is remembered only when pages were really read, not when the site couldn't be reached.
  if (!email && !loaded) return null;
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${key}, ${JSON.stringify({ email })}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return email;
}
