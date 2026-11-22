import tls from "node:tls";
import type { Connection } from "../connection";
import { resolveRange } from "../dates";
import { ensureSchema, sql } from "../db";
import { googleRequest, hasScope, type GoogleAuth } from "../google-auth";
import { gscClicks28d } from "../seo-tools";
import { safeFetch } from "./broken-links";
import type { Problem } from "./inspector";
import { report } from "./status";

/**
 * Site watch: checks the site itself works and is measured, for every site, without being asked.
 *
 * Every hour: the home page answers, and quickly.
 * Every day: the security certificate is not about to expire; robots.txt and the home page don't shut Google out;
 * Search Console has a sitemap without errors (one is added when it is missing and the app may); and Google Analytics
 * counts the visits Search Console sees, with the reason found on the page when it doesn't (no tag, another property's
 * tag, or a tag that waits, as for a cookie notice), and that Analytics has not stopped recording.
 *
 * What it finds goes to the Inspector (and from there to the team board, the owner's alerts and the code repair run).
 * Findings are facts read from the site, Google or Analytics; a likely cause is said to be likely.
 */

const HOUR = 3_600_000;
const key = (accountId: string) => `site_watch:${accountId}`;

interface WatchState {
  at: string;
  dailyAt: string | null;
  /** Home page failures in a row, so one blip isn't an alarm. */
  downRuns: number;
  hourly: Problem[];
  daily: Problem[];
}

// ---------- pure checks, tested ----------

/** Whether robots.txt shuts every crawler out of the whole site ("User-agent: *" with "Disallow: /"). */
export function robotsBlocksAll(text: string): boolean {
  let inStar = false;
  let sawRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const field = k.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (field === "user-agent") {
      // A new group starts after rules; agents listed together share one group.
      if (sawRule) {
        inStar = false;
        sawRule = false;
      }
      if (value === "*") inStar = true;
    } else if (field === "disallow" || field === "allow") {
      sawRule = true;
      if (inStar && field === "disallow" && value === "/") return true;
    }
  }
  return false;
}

/** Whether a page tells search engines not to index it, in its HTML or its X-Robots-Tag header. */
export function pageNoindex(html: string, robotsHeader: string | null): boolean {
  if (robotsHeader && /noindex|none/i.test(robotsHeader)) return true;
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0];
    if (/name\s*=\s*["']?(robots|googlebot)["']?/i.test(tag) && /content\s*=\s*["'][^"']*(noindex|none)[^"']*["']/i.test(tag)) return true;
  }
  return false;
}

/** Google Analytics measurement ids (G-...) and Tag Manager containers (GTM-...) named anywhere in a page. */
export function tagIds(html: string): { ga: string[]; gtm: string[]; loader: boolean } {
  return {
    ga: [...new Set(html.match(/\bG-[A-Z0-9]{6,12}\b/g) ?? [])],
    gtm: [...new Set(html.match(/\bGTM-[A-Z0-9]{4,10}\b/g) ?? [])],
    // The page asks for Google's tag script as it loads, rather than adding it later from code.
    loader: /<script[^>]+googletagmanager\.com\/(gtag\/js|gtm\.js)/i.test(html),
  };
}

/**
 * Why Analytics counts fewer Google visits than Search Console, from what the page shows. Null when the page gives no
 * reason (the cause is elsewhere, or only a person can tell).
 */
export function tagDiagnosis(page: ReturnType<typeof tagIds>, streamIds: string[] | null): { cause: string; fix: string } | null {
  if (!page.ga.length && !page.gtm.length) {
    return {
      cause: "The home page has no Google Analytics tag at all.",
      fix: "Add the Google Analytics tag to every page of the site (the measurement id starts with G-), or use the DashPatrol snippet's Analytics option.",
    };
  }
  if (streamIds && streamIds.length && page.ga.length && !page.gtm.length && !page.ga.some((id) => streamIds.includes(id))) {
    return {
      cause: `The site's tag (${page.ga.join(", ")}) belongs to a different Analytics property than the one connected (${streamIds.join(", ")}).`,
      fix: "Connect the property the site's tag sends to, or change the tag on the site to the connected property's measurement id.",
    };
  }
  if (page.ga.length && !page.loader && !page.gtm.length) {
    return {
      cause: "The tag is named on the page but not loaded with it, which usually means it waits for something first, such as a visitor accepting a cookie notice. Visitors who never click aren't counted.",
      fix: "Load Analytics for every visitor and let them turn it off (where the law allows), or expect Analytics to show only visitors who opted in.",
    };
  }
  return null;
}

/** Analytics counts a much smaller share of Google visits than Search Console reports clicks. */
export const trackingGap = (gscClicks: number, gaGoogleSessions: number) => gscClicks >= 20 && gaGoogleSessions < gscClicks * 0.4;

// ---------- reading the site and Google ----------

async function fetchText(url: string, timeout = 15_000): Promise<{ status: number; ms: number; text: string; robots: string | null } | null> {
  const t0 = Date.now();
  const res = await safeFetch(url, "GET", timeout).catch(() => null);
  if (!res || res === "unresolved") return null;
  const text = await res.text().catch(() => "");
  return { status: res.status, ms: Date.now() - t0, text: text.slice(0, 2_000_000), robots: res.headers.get("x-robots-tag") };
}

/** Days until the site's security certificate expires, or null when it can't be read. */
function certDays(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const valid = s.getPeerCertificate()?.valid_to;
      s.end();
      resolve(valid ? Math.floor((Date.parse(valid) - Date.now()) / 86_400_000) : null);
    });
    s.on("error", () => resolve(null));
    s.on("timeout", () => (s.destroy(), resolve(null)));
  });
}

async function gaGoogleSessions(conn: Connection): Promise<{ last28: number; last3: number } | null> {
  if (!conn.gaPropertyId) return null;
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  const { current } = resolveRange("28d", 3);
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${conn.gaPropertyId}:runReport`;
  type Rows = { rows?: { metricValues: { value: string }[] }[] };
  const [google, recent] = await Promise.all([
    googleRequest<Rows>(auth, url, {
      dateRanges: [{ startDate: current.start, endDate: current.end }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: { andGroup: { expressions: [
        { filter: { fieldName: "sessionSource", stringFilter: { value: "google" } } },
        { filter: { fieldName: "sessionMedium", stringFilter: { value: "organic" } } },
      ] } },
    }),
    googleRequest<Rows>(auth, url, { dateRanges: [{ startDate: "3daysAgo", endDate: "yesterday" }], metrics: [{ name: "sessions" }] }),
  ]);
  const n = (r: Rows) => Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  return { last28: n(google), last3: n(recent) };
}

async function gaStreamIds(conn: Connection): Promise<string[] | null> {
  if (!conn.gaPropertyId) return null;
  const body = await googleRequest<{ dataStreams?: { webStreamData?: { measurementId?: string } }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://analyticsadmin.googleapis.com/v1beta/properties/${conn.gaPropertyId}/dataStreams`,
  ).catch(() => null);
  return body ? (body.dataStreams ?? []).map((d) => d.webStreamData?.measurementId ?? "").filter(Boolean) : null;
}

// ---------- the run ----------

async function readState(accountId: string): Promise<WatchState> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key(accountId)}`;
  try {
    const v = row?.value ? (JSON.parse(row.value) as Partial<WatchState>) : {};
    return { at: v.at ?? "", dailyAt: v.dailyAt ?? null, downRuns: Number(v.downRuns) || 0, hourly: v.hourly ?? [], daily: v.daily ?? [] };
  } catch {
    return { at: "", dailyAt: null, downRuns: 0, hourly: [], daily: [] };
  }
}

/** What Site watch last found, for the Inspector. */
export async function siteWatchProblems(accountId: string): Promise<Problem[]> {
  const st = await readState(accountId).catch(() => null);
  return st ? [...st.hourly, ...st.daily] : [];
}

/** Sites with a website whose hourly watch is due, longest waiting first. */
export async function accountsDueForSiteWatch(limit: number): Promise<{ accountId: string; domain: string }[]> {
  await ensureSchema();
  const rows = await sql`SELECT p.account_id, p.site_domain FROM insights_account_profile p
    LEFT JOIN insights_settings s ON s.key = 'site_watch:' || p.account_id
    WHERE p.site_domain IS NOT NULL AND p.site_domain <> '' AND (s.updated_at IS NULL OR s.updated_at < now() - interval '50 minutes')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => ({ accountId: String(r.account_id), domain: String(r.site_domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") }));
}

export async function runSiteWatch(accountId: string, domain: string, conn: Connection | null): Promise<string> {
  const st = await readState(accountId);
  const host = domain.replace(/^www\./, "");
  const home = `https://${domain}/`;
  const notes: string[] = [];

  // Hourly: the home page answers.
  const page = await fetchText(home);
  const down = !page || page.status >= 400;
  st.downRuns = down ? st.downRuns + 1 : 0;
  st.hourly = [];
  if (down && st.downRuns >= 2) {
    st.hourly.push({
      id: "site:down",
      text: page ? `The home page answers with error ${page.status} (two checks in a row).` : "The home page does not answer at all (two checks in a row).",
      fix: "Check the hosting and the domain. Visitors and Google can't reach the site until it answers.",
      who: "owner",
    });
  } else if (page && !down && page.ms > 8000) {
    st.hourly.push({ id: "site:slow", text: `The home page took ${Math.round(page.ms / 1000)} seconds to load.`, fix: "Check the hosting; the speed agent's page fixes help too.", who: "watching" });
  }
  notes.push(down ? `home page ${page ? page.status : "no answer"}` : `home page ${page!.status} in ${page!.ms} ms`);

  // Daily: everything heavier.
  if (!st.dailyAt || Date.now() - Date.parse(st.dailyAt) > 20 * HOUR) {
    const daily: Problem[] = [];
    const days = await certDays(host);
    if (days !== null && days < 14) {
      daily.push({
        id: "site:certificate",
        text: days < 0 ? "The site's security certificate has expired; browsers warn visitors away." : `The site's security certificate expires in ${days} days.`,
        fix: "Renew it at the hosting company (most renew by themselves when auto renew is on).",
        who: "owner",
      });
    }
    const robots = await fetchText(`https://${domain}/robots.txt`, 10_000);
    if (robots && robots.status < 400 && robotsBlocksAll(robots.text)) {
      daily.push({ id: "site:robots", text: "robots.txt tells every search engine to stay out of the whole site.", fix: "Remove the line Disallow: / under User-agent: * in robots.txt.", who: "owner" });
    }
    if (page && !down && pageNoindex(page.text, page.robots)) {
      daily.push({ id: "site:noindex", text: "The home page tells Google not to index it (noindex).", fix: "Remove the noindex setting from the home page.", who: "owner" });
    }
    if (conn?.gscSiteUrl) {
      const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
      const site = encodeURIComponent(conn.gscSiteUrl);
      const maps = await googleRequest<{ sitemap?: { path?: string; errors?: string; warnings?: string }[] }>(auth, `https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps`).catch(() => null);
      if (maps) {
        const list = maps.sitemap ?? [];
        const errors = list.reduce((a, m) => a + Number(m.errors ?? 0), 0);
        if (!list.length) {
          // Added when the site has one and the app may manage Search Console; otherwise the owner is told.
          const xml = await fetchText(`https://${domain}/sitemap.xml`, 10_000);
          const may = await hasScope(auth, "https://www.googleapis.com/auth/webmasters").catch(() => false);
          const added = xml && xml.status < 400 && /<(urlset|sitemapindex)/i.test(xml.text) && may
            ? await googleRequest(auth, `https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps/${encodeURIComponent(`https://${domain}/sitemap.xml`)}`, undefined, {}, "PUT").then(() => true, () => false)
            : false;
          daily.push(
            added
              ? { id: "site:sitemap", text: "Search Console had no sitemap for this site.", fix: "Added the site's sitemap.xml to Search Console, so Google finds new pages sooner.", who: "repaired" }
              : { id: "site:sitemap", text: "Search Console has no sitemap for this site.", fix: "Add the site's sitemap (usually /sitemap.xml) in Search Console, under Sitemaps.", who: "owner" },
          );
        } else if (errors > 0) {
          daily.push({ id: "site:sitemap", text: `Google found ${errors} ${errors === 1 ? "error" : "errors"} in the site's sitemap.`, fix: "Open Search Console, Sitemaps, to see which addresses fail, and fix or remove them.", who: "owner" });
        }
      }
      // Measurement: Analytics should count about the Google visits Search Console reports.
      if (conn.gaPropertyId) {
        const [clicks, ga] = await Promise.all([gscClicks28d(conn).catch(() => null), gaGoogleSessions(conn).catch(() => null)]);
        if (ga && ga.last3 === 0 && clicks !== null && clicks >= 30) {
          daily.push({ id: "measure:stopped", text: "Google Analytics recorded no visits at all in the last 3 days, while Google still sends visitors.", fix: "Check that the Analytics tag is still on the site and that the property is the one connected.", who: "owner" });
        } else if (ga && clicks !== null && trackingGap(clicks, ga.last28)) {
          const why = page && !down ? tagDiagnosis(tagIds(page.text), await gaStreamIds(conn).catch(() => null)) : null;
          daily.push({
            id: "measure:gap",
            text: `Google Analytics counted ${ga.last28} visits from Google search in the last 28 days, while Search Console counted ${clicks} clicks. ${why?.cause ?? "The page itself shows no reason, so the tag may be missing on some pages or blocked for some visitors."}`,
            fix: why?.fix ?? "Check that every page loads the Analytics tag for the connected property.",
            who: "owner",
          });
        }
        notes.push(`analytics ${ga ? ga.last28 : "unread"} vs search console ${clicks ?? "unread"}`);
      }
    }
    st.daily = daily;
    st.dailyAt = new Date().toISOString();
    notes.push(`daily checks: ${daily.length ? daily.map((d) => d.id).join(", ") : "all clear"}`);
  }
  st.at = new Date().toISOString();
  await sql`INSERT INTO insights_settings (key, value) VALUES (${key(accountId)}, ${JSON.stringify(st)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await report("site-watch", true);
  return notes.join("; ");
}
