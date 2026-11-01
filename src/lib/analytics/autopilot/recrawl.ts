import type { Connection } from "../connection";
import { googleRequest, hasScope } from "../google-auth";

/**
 * Tells Google right away that pages changed, by resubmitting the site's sitemaps in Search Console (Google's
 * recommended way to get many changed pages recrawled). It doesn't promise a faster ranking, only a sooner look.
 * At most once a day per site: Google ignores repeated submissions anyway.
 */
const lastSent = new Map<string, number>();

export async function askGoogleToRecrawl(conn: Connection, ourDomain: string): Promise<string | null> {
  if (!conn.gscSiteUrl) return null;
  const site = conn.gscSiteUrl;
  if (Date.now() - (lastSent.get(site) ?? 0) < 20 * 3600_000) return null;
  const auth = { kind: "oauth" as const, refreshToken: conn.refreshToken };
  const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`;
  // Only a connection made with "Set it up for me" may submit sitemaps; a read only one is skipped, not failed.
  lastSent.set(site, Date.now());
  if (!(await hasScope(auth, "https://www.googleapis.com/auth/webmasters").catch(() => false))) return null;
  try {
    const listed = await googleRequest<{ sitemap?: { path: string }[] }>(auth, base, undefined, {}, "GET");
    const paths = (listed.sitemap ?? []).map((s) => s.path).filter(Boolean);
    if (!paths.length && ourDomain) paths.push(`https://${ourDomain.replace(/^www\./, "")}/sitemap.xml`);
    for (const p of paths.slice(0, 5)) await googleRequest(auth, `${base}/${encodeURIComponent(p)}`, undefined, {}, "PUT");
    return `Asked Google to recrawl the changed pages (sitemap resubmitted in Search Console).`;
  } catch (e) {
    // Said plainly in the run summary (owner and Inspector see it); Google's own wording goes to the log.
    console.error(`sitemap resubmit failed for ${site}: ${(e as Error).message}`);
    return "Couldn't ask Google to recrawl the changed pages this time. The next run tries again.";
  }
}
