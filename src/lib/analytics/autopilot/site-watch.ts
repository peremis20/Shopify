import tls from "node:tls";
import type { Connection } from "../connection";
import { resolveRange } from "../dates";
import { ensureSchema, sql } from "../db";
import { googleRequest, hasScope, type GoogleAuth } from "../google-auth";
import { publicFetch } from "../profile";
import { isSabbath } from "./sabbath";
import { readCapped } from "./broken-links";
import type { Problem } from "./inspector";

/**
 * Site watch: checks the site itself works, is open to Google and is measured, for every site, without being asked.
 *
 * Every hour: the home page answers, and quickly.
 * Every day: the security certificate and the domain registration are not about to run out; robots.txt and the home
 * page don't shut Google out; http moves to https and the other www form doesn't show a second copy; Search Console has
 * a sitemap without errors (added when missing and the app may); Google Analytics counts about the Google visits Search
 * Console sees for the same site, with what the page shows about why when it doesn't; Analytics has not stopped
 * recording; the agents' title changes show on the live pages; and the weekly report reached the owner.
 *
 * What it finds goes to the Inspector (and from there to the team board, the owner's urgent emails for a site that is
 * down, expiring or shut out of Google, and the code repair run). Findings are facts read from the site, Google or
 * Analytics; a possible cause is said to be possible. A check that couldn't be done says nothing.
 */

const HOUR = 3_600_000;
const key = (accountId: string) => `site_watch:${accountId}`;
const BROWSER = "Mozilla/5.0 (compatible; SiteWatch/1.0; +https://app.dashpatrol.io)";

interface WatchState {
  at: string;
  dailyAt: string | null;
  /** Home page failures in a row, so one blip isn't an alarm. */
  downRuns: number;
  hourly: Problem[];
  daily: Problem[];
  /** The last run's own failure, if it had one. */
  error: string | null;
  /** When each daily finding was last confirmed by a check that ran, so one that can't be rechecked doesn't stay forever. */
  seen: Record<string, string>;
}

/** How long a daily finding is kept while its check can't run. */
const KEEP_FOR = 72 * HOUR;
/** Days left, in words: "today", "in 1 day", "in 5 days". */
export const daysLeft = (n: number) => (n <= 0 ? "today" : `in ${n} ${n === 1 ? "day" : "days"}`);

// ---------- pure checks, tested ----------

/**
 * Whether robots.txt shuts Google out of the whole site. Google follows its own group when there is one ("Googlebot"),
 * else the group for every crawler ("*"); only a "Disallow: /" with no Allow rule beside it closes the whole site.
 */
export function robotsBlocksAll(text: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      // Agents listed one after another share a group; a rule ends the list.
      if (!cur || cur.rules.length) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
    } else if ((field === "disallow" || field === "allow") && cur) {
      cur.rules.push({ allow: field === "allow", path: value });
    }
  }
  const group = groups.find((g) => g.agents.includes("googlebot")) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return false;
  return group.rules.some((r) => !r.allow && r.path === "/") && !group.rules.some((r) => r.allow && r.path);
}

const NOINDEX = (directives: string) => directives.split(",").some((d) => ["noindex", "none"].includes(d.trim().toLowerCase()));

/** Whether a page tells Google not to index it, in its robots meta tag or its X-Robots-Tag header. */
export function pageNoindex(html: string, robotsHeader: string | null): boolean {
  if (robotsHeader) {
    // "googlebot: noindex" speaks to Google; "otherbot: noindex" doesn't; plain directives speak to every crawler.
    const m = robotsHeader.match(/^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i);
    const scoped = m && !/^(max|unavailable_after)/i.test(m[1]);
    if (scoped ? /^googlebot$/i.test(m![1]) && NOINDEX(m![2]) : NOINDEX(robotsHeader)) return true;
  }
  for (const t of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = t[0];
    const name = tag.match(/\bname\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if ((name === "robots" || name === "googlebot") && NOINDEX(content)) return true;
  }
  return false;
}

/** What the page shows about Google Analytics: tag ids in tag code, and whether a tag loads with the page. */
export function tagIds(html: string): { ga: string[]; gtm: string[]; loader: boolean; pixels: boolean } {
  // Ids are taken from tag code (the gtag script address, a config call, an id field), not from any text on the page.
  const ga = [...html.matchAll(/(?:gtag\/js\?id=|config['"]?\s*,\s*['"]|["']?(?:id|measurementId|tagId)["']?\s*[:=]\s*\\?["'])(G-[A-Z0-9]{6,12})\b/g)].map((m) => m[1]);
  return {
    ga: [...new Set(ga)],
    gtm: [...new Set(html.match(/\bGTM-[A-Z0-9]{4,10}\b/g) ?? [])],
    // Google's tag script asked for as the page loads: a script tag, or a preload link (as Next.js writes it).
    loader: /<(script|link)\b[^>]+googletagmanager\.com\/(gtag\/js|gtm\.js)/i.test(html),
    // Shopify's own pixels load Google's tag outside the page's HTML.
    pixels: /web-pixels|Shopify\.analytics|trekkie/i.test(html),
  };
}

/**
 * What the page shows about why Analytics counts fewer Google visits than Search Console. Null when the page gives no
 * reason; a possible cause is worded as possible.
 */
export function tagDiagnosis(page: ReturnType<typeof tagIds>, streamIds: string[] | null): { cause: string; fix: string } | null {
  if (page.pixels || page.gtm.length) return null;
  if (!page.ga.length && !page.loader) {
    return {
      cause: "The home page shows no Google Analytics tag.",
      fix: "Add the Google Analytics tag to every page of the site (the measurement id starts with G), or use the DashPatrol snippet's Analytics option.",
    };
  }
  if (streamIds && streamIds.length && page.ga.length && !page.ga.some((id) => streamIds.includes(id))) {
    return {
      cause: `The site's tag (${page.ga.join(", ")}) is not one of the connected Analytics property's (${streamIds.join(", ")}).`,
      fix: "Connect the property the site's tag sends to, or change the tag on the site to the connected property's measurement id.",
    };
  }
  if (page.ga.length && !page.loader) {
    return {
      cause: "The tag is named on the page but doesn't load with it. It may wait for something first, such as a visitor accepting a cookie notice; visitors who never do aren't counted.",
      fix: "Check when the tag loads. If it waits for consent, Analytics will only count the visitors who agree.",
    };
  }
  return null;
}

/** The page's <title> text, entities and spacing tidied, for comparing with what an agent set. */
export function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&apos;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, "-").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/** Whether the live title carries the title an agent set (themes may add the store name around it). */
const plainText = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
export const titleIsLive = (live: string | null, set: string) => Boolean(live && set.trim() && plainText(live).includes(plainText(set)));

/** The registered domain, for its registration record: the last two labels (a country domain like .co.uk keeps three). */
export function registeredDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  const take = parts.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-take).join(".");
}

/** Analytics counts a much smaller share of Google visits than Search Console reports clicks for the same site. */
export const trackingGap = (gscClicks: number, gaGoogleSessions: number) => gscClicks >= 20 && gaGoogleSessions < gscClicks * 0.4;

/**
 * Whether an answer means the page is down, or only that it wouldn't answer a checker (a bot check, a rate limit or a
 * login): those can't say the site is down, so they say nothing.
 */
export function downAnswer(status: number, server: string | null, mitigated: string | null): "down" | "blocked" | "up" {
  if (status < 400) return "up";
  if (status === 401 || status === 403 || status === 429 || mitigated) return "blocked";
  if (status === 503 && /cloudflare|sucuri|akamai/i.test(server ?? "")) return "blocked";
  return "down";
}

// ---------- reading the site and Google ----------

interface Fetched {
  status: number;
  ms: number;
  text: string;
  robots: string | null;
  server: string | null;
  mitigated: string | null;
  /** The body couldn't be read in full (cut off by the time limit or a broken connection): nothing is judged from it. */
  partial: boolean;
  /** Where the redirects ended. */
  finalUrl: string;
}

async function fetchText(url: string, timeout = 15_000, stop?: AbortSignal): Promise<Fetched | null> {
  const t0 = Date.now();
  const signal = stop ? AbortSignal.any([AbortSignal.timeout(timeout), stop]) : AbortSignal.timeout(timeout);
  // Only a public website (publicFetch checks the address and every redirect), read like a browser would.
  const res = await publicFetch(url, { headers: { "User-Agent": BROWSER, Accept: "text/html,*/*" }, signal }).catch(() => null);
  if (!res) return null;
  let partial = false;
  const text = await readCapped(res, 2_000_000).catch(() => ((partial = true), ""));
  return {
    status: res.status,
    ms: Date.now() - t0,
    text,
    robots: res.headers.get("x-robots-tag"),
    server: res.headers.get("server"),
    mitigated: res.headers.get("cf-mitigated"),
    partial,
    finalUrl: res.url || url,
  };
}

/** The certificate the host shows: days until it ends, and why a browser would refuse it. Null when it can't be read. */
function certificate(host: string): Promise<{ days: number | null; refused: string | null } | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10_000, rejectUnauthorized: false }, () => {
      const valid = s.getPeerCertificate()?.valid_to;
      const refused = s.authorized ? null : String(s.authorizationError ?? "not trusted");
      s.end();
      resolve({ days: valid ? Math.floor((Date.parse(valid) - Date.now()) / 86_400_000) : null, refused });
    });
    s.on("error", () => resolve(null));
    s.on("timeout", () => (s.destroy(), resolve(null)));
  });
}

type Rows = { rows?: { metricValues: { value: string }[] }[] };
const firstNumber = (r: Rows) => Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0);

/** Analytics sessions: from Google search over the 28 days Search Console is read for, all sessions in those 28 days, and in the last 3 days. */
async function gaSessions(conn: Connection, signal?: AbortSignal): Promise<{ google28: number; all28: number; last3: number; from: string } | null> {
  if (!conn.gaPropertyId) return null;
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  const { current } = resolveRange("28d", 3);
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${conn.gaPropertyId}:runReport`;
  const [google, all, recent] = await Promise.all([
    googleRequest<Rows>(auth, url, {
      dateRanges: [{ startDate: current.start, endDate: current.end }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: { andGroup: { expressions: [
        { filter: { fieldName: "sessionSource", stringFilter: { value: "google" } } },
        { filter: { fieldName: "sessionMedium", stringFilter: { value: "organic" } } },
      ] } },
    }, {}, undefined, signal),
    googleRequest<Rows>(auth, url, { dateRanges: [{ startDate: current.start, endDate: current.end }], metrics: [{ name: "sessions" }] }, {}, undefined, signal),
    // The 3 full days before yesterday, so a day Google is still processing isn't read as empty.
    googleRequest<Rows>(auth, url, { dateRanges: [{ startDate: "4daysAgo", endDate: "2daysAgo" }], metrics: [{ name: "sessions" }] }, {}, undefined, signal),
  ]);
  return { google28: firstNumber(google), all28: firstNumber(all), last3: firstNumber(recent), from: current.start };
}

/** Search Console clicks over the same 28 days, for the pages on one host only (so a blog or shop subdomain isn't counted). */
async function gscClicksForHost(conn: Connection, host: string, signal?: AbortSignal): Promise<number | null> {
  if (!conn.gscSiteUrl) return null;
  const { current } = resolveRange("28d", 3);
  const body = await googleRequest<{ rows?: { clicks: number }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl)}/searchAnalytics/query`,
    {
      startDate: current.start,
      endDate: current.end,
      dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: `//${host}/` }] }],
      rowLimit: 1,
    },
    {},
    undefined,
    signal,
  );
  return (body.rows ?? []).reduce((a, r) => a + r.clicks, 0);
}

async function gaStreams(conn: Connection, signal?: AbortSignal): Promise<{ ids: string[]; hosts: string[] } | null> {
  if (!conn.gaPropertyId) return null;
  const body = await googleRequest<{ dataStreams?: { webStreamData?: { measurementId?: string; defaultUri?: string } }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://analyticsadmin.googleapis.com/v1beta/properties/${conn.gaPropertyId}/dataStreams`,
    undefined,
    {},
    undefined,
    signal,
  ).catch(() => null);
  if (!body) return null;
  const web = (body.dataStreams ?? []).map((d) => d.webStreamData).filter(Boolean);
  return {
    ids: web.map((w) => w!.measurementId ?? "").filter(Boolean),
    hosts: web.map((w) => {
      try {
        return new URL(w!.defaultUri ?? "").hostname.toLowerCase();
      } catch {
        return "";
      }
    }).filter(Boolean),
  };
}

/** The sitemap addresses robots.txt names, else /sitemap.xml under the address Search Console knows the site by. */
function sitemapCandidates(robotsTxt: string | null, gscSiteUrl: string, host: string): string[] {
  const named = [...(robotsTxt ?? "").matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
  const base = /^https?:\/\//.test(gscSiteUrl) ? gscSiteUrl : `https://${host}/`;
  return [...new Set([...named, new URL("sitemap.xml", base).toString()])];
}

// ---------- the run ----------

async function readState(accountId: string): Promise<WatchState> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key(accountId)}`;
  try {
    const v = row?.value ? (JSON.parse(row.value) as Partial<WatchState>) : {};
    return { at: v.at ?? "", dailyAt: v.dailyAt ?? null, downRuns: Number(v.downRuns) || 0, hourly: v.hourly ?? [], daily: v.daily ?? [], error: v.error ?? null, seen: v.seen ?? {} };
  } catch {
    return { at: "", dailyAt: null, downRuns: 0, hourly: [], daily: [], error: null, seen: {} };
  }
}

async function saveState(accountId: string, st: WatchState): Promise<void> {
  await sql`INSERT INTO insights_settings (key, value) VALUES (${key(accountId)}, ${JSON.stringify(st)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** What Site watch last found, for the Inspector. Old findings are dropped, and a watch that stopped says so. */
export async function siteWatchProblems(accountId: string): Promise<Problem[]> {
  const st = await readState(accountId);
  if (!st.at) return [];
  const age = Date.now() - Date.parse(st.at);
  const out: Problem[] = [];
  if (age < 6 * HOUR) out.push(...st.hourly);
  // A finding the hourly check made wins over a daily one with the same id (a refused certificate).
  if (st.dailyAt && Date.now() - Date.parse(st.dailyAt) < 48 * HOUR) out.push(...st.daily.filter((d) => !out.some((h) => h.id === d.id)));
  // Nothing runs on the Sabbath, so a watch that waited through it isn't late.
  if (age > 6 * HOUR && !isSabbath() && !isSabbath(new Date(Date.now() - 6 * HOUR))) {
    out.push({ id: "site:watch-late", text: "Site watch hasn't checked this site in over 6 hours.", fix: "The code repair run looks at why.", who: "watching", platform: true });
  }
  if (st.error) out.push({ id: "site:watch-error", text: `Site watch couldn't finish its last check: ${st.error}`, fix: "It tries again within the hour.", who: "watching", platform: true });
  return out;
}

const hostOf = (s: string) => s.toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[/:].*$/, "");

/** Sites with a website (from the profile, else Search Console) whose hourly watch is due, longest waiting first. */
export async function accountsDueForSiteWatch(limit: number): Promise<{ accountId: string; domain: string }[]> {
  await ensureSchema();
  const rows = await sql`SELECT a.account_id, p.site_domain, g.gsc_site_url FROM insights_account_autopilot a
    LEFT JOIN insights_account_profile p ON p.account_id = a.account_id
    LEFT JOIN insights_account_google g ON g.account_id = a.account_id
    LEFT JOIN insights_settings s ON s.key = 'site_watch:' || a.account_id
    WHERE a.enabled AND (coalesce(p.site_domain, '') <> '' OR coalesce(g.gsc_site_url, '') <> '')
      AND (s.updated_at IS NULL OR s.updated_at < now() - interval '50 minutes')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows
    .map((r) => ({ accountId: String(r.account_id), domain: hostOf(String(r.site_domain || r.gsc_site_url || "")) }))
    .filter((r) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(r.domain));
}

/** One site's watch. Saved however it ends; a failure part way is kept in the site's state and thrown for the status board. */
export async function runSiteWatch(
  accountId: string,
  domain: string,
  /** Read inside the run, so a failed read is this site's failure rather than "not connected". */
  connection: () => Promise<Connection | null>,
  /** Stops the run when the tick's time limit for it is up. */
  stop?: AbortSignal,
): Promise<{ note: string; urgent: boolean }> {
  const st = await readState(accountId);
  const notes: string[] = [];
  const dailyBefore = st.dailyAt;
  try {
    await watch(accountId, domain, await connection(), st, notes, stop);
    st.error = null;
    // Something only the owner can fix sends the site to the Inspector this hour, so the alert goes out now.
    return { note: notes.join("; "), urgent: [...st.hourly, ...(st.dailyAt !== dailyBefore ? st.daily : [])].some((p) => p.who === "owner") };
  } catch (e) {
    st.error = stop?.aborted ? "it took too long and was stopped" : String((e as Error)?.message ?? e).slice(0, 300);
    throw e;
  } finally {
    st.at = new Date().toISOString();
    await saveState(accountId, st).catch((e) => console.error(`site watch state not saved: ${(e as Error).message}`));
  }
}

async function watch(accountId: string, domain: string, conn: Connection | null, st: WatchState, notes: string[], stop?: AbortSignal): Promise<void> {
  // A run stopped for time says nothing: an aborted read is not an answer from the site.
  const check = () => stop?.throwIfAborted();
  // Hourly: the home page answers. A bot check, rate limit or login says nothing; two real failures in a row
  // (within a few hours of each other) are an alarm.
  if (st.at && Date.now() - Date.parse(st.at) > 3 * HOUR) st.downRuns = 0;
  const page = await fetchText(`https://${domain}/`, 15_000, stop);
  check();
  const state = page ? downAnswer(page.status, page.server, page.mitigated) : "down";
  // An answer of any kind (even a blocked one) breaks a run of failures, so "two checks in a row" stays true.
  st.downRuns = state === "down" ? st.downRuns + 1 : 0;
  const before = st.hourly;
  st.hourly = [];
  // No answer may be a certificate browsers refuse rather than a site that's down: say which.
  const badCert = !page ? await certificate(domain) : null;
  check();
  if (!page && badCert?.refused) {
    st.hourly.push({ id: "site:certificate", text: `Browsers refuse the site's security certificate (${badCert.refused}), so visitors see a warning instead of the site.`, fix: "Renew or fix the certificate at the hosting company.", who: "owner" });
  } else if (state === "down" && st.downRuns >= 2) {
    st.hourly.push({
      id: "site:down",
      text: page ? `The home page answers with error ${page.status} (two checks in a row).` : "The home page does not answer at all (two checks in a row).",
      fix: "Check the hosting and the domain. Visitors and Google can't reach the site until it answers.",
      who: "owner",
    });
  } else if (state === "blocked") {
    // Couldn't tell this hour: what was found before stands, except that the site is down (it answered, if only to say no).
    // A blocked answer also means the certificate was accepted (fetch checks it).
    st.hourly = before.filter((p) => p.id !== "site:down" && p.id !== "site:certificate");
  } else if (page && state === "up" && page.ms > 8000) {
    st.hourly.push({ id: "site:slow", text: `The home page took ${Math.round(page.ms / 1000)} seconds to load.`, fix: "Check the hosting; the speed agent's page fixes help too.", who: "watching" });
  }
  notes.push(page ? `home page ${page.status} in ${page.ms} ms` : "home page no answer");
  const up = page && state === "up" ? page : null;
  // A page read in full (not a redirect the reader stopped at), for anything judged from its HTML.
  const read = up && up.status < 300 && !up.partial ? up : null;
  // The host the site is really served on (after redirects), for its certificate and its other www form.
  const live = up ? new URL(up.finalUrl).hostname.toLowerCase() : domain;

  if (st.dailyAt && Date.now() - Date.parse(st.dailyAt) < 20 * HOUR) return;
  const daily: Problem[] = [];
  // A check that couldn't run this time keeps what it found last time, so a lasting problem isn't dropped and then
  // reported again as new; but only for a few days from when it was last confirmed, so a finding that can't be
  // rechecked (or was fixed in a way the check can't see) doesn't stay forever.
  const keptIds = new Set<string>();
  const kept = (...ids: string[]) => {
    for (const p of st.daily) {
      const confirmed = Date.parse(st.seen[p.id] ?? st.dailyAt ?? "");
      if (ids.includes(p.id) && Date.now() - confirmed < KEEP_FOR) {
        daily.push(p);
        keptIds.add(p.id);
      }
    }
  };

  const [cert, robots, reg, plain, other] = await Promise.all([
    up ? certificate(live) : Promise.resolve(null),
    up ? fetchText(`https://${live}/robots.txt`, 10_000, stop) : Promise.resolve(null),
    fetchText(`https://rdap.org/domain/${registeredDomain(live)}`, 10_000, stop),
    up ? fetchText(`http://${live}/`, 10_000, stop) : Promise.resolve(null),
    up ? fetchText(`https://${live.startsWith("www.") ? live.slice(4) : `www.${live}`}/`, 10_000, stop) : Promise.resolve(null),
  ]);
  check();

  if (!cert) kept("site:certificate");
  else if (cert.refused) {
    daily.push({ id: "site:certificate", text: `Browsers refuse the site's security certificate (${cert.refused}).`, fix: "Renew or fix the certificate at the hosting company.", who: "owner" });
  } else if (cert.days !== null && cert.days < 14) {
    daily.push({ id: "site:certificate", text: `The site's security certificate expires ${daysLeft(cert.days)}.`, fix: "Renew it at the hosting company (most renew by themselves when auto renew is on).", who: "owner" });
  }

  const robotsRead = robots && robots.status < 300 && !robots.partial ? robots : null;
  // No robots.txt (404 or 410) means nothing is shut out; any other failure (a redirect, a bot check, a server error)
  // couldn't be read, so what was found before stands.
  if (!up || !robots || robots.partial || (robots.status >= 300 && robots.status !== 404 && robots.status !== 410)) kept("site:robots");
  else if (robotsRead && robotsBlocksAll(robotsRead.text)) {
    daily.push({ id: "site:robots", text: "robots.txt tells Google to stay out of the whole site.", fix: "Remove the line Disallow: / (for Googlebot or for every crawler) in robots.txt.", who: "owner" });
  }
  if (!read) kept("site:noindex");
  else if (pageNoindex(read.text, read.robots)) {
    daily.push({ id: "site:noindex", text: "The home page tells Google not to index it (noindex).", fix: "Remove the noindex setting from the home page.", who: "owner" });
  }

  // The domain's registration: an expired domain takes the whole site and its email down. Registrars often renew
  // in the last weeks, so only the final week (or an expired domain) is urgent.
  const name = registeredDomain(live);
  let regRead = false;
  if (reg && reg.status < 300) {
    try {
      const events = (JSON.parse(reg.text) as { events?: { eventAction?: string; eventDate?: string }[] }).events ?? [];
      const exp = events.find((e) => e.eventAction === "expiration")?.eventDate;
      const left = exp ? Math.floor((Date.parse(exp) - Date.now()) / 86_400_000) : null;
      regRead = true;
      if (left !== null && !Number.isNaN(left) && left <= 7) {
        daily.push({
          id: "site:domain",
          text: left < 0 ? `The domain ${name} has expired.` : `The domain ${name} expires ${daysLeft(left)}.`,
          fix: "Renew it with the company it was bought from, and turn on auto renew.",
          who: "owner",
        });
      } else if (left !== null && !Number.isNaN(left) && left <= 30) {
        daily.push({ id: "site:domain-soon", text: `The domain ${name} expires ${daysLeft(left)}.`, fix: "Most domains renew by themselves in the last weeks; if auto renew is off, renew it with the company it was bought from.", who: "watching" });
      }
    } catch {
      /* no readable registration record: nothing is claimed */
    }
  }
  if (!regRead) kept("site:domain", "site:domain-soon");

  // One address: plain http moves to https, and the other www form reaches the same site rather than a second copy.
  // No answer on http at all means there is no http copy to send on.
  if (!up || (plain && plain.status >= 300)) kept("site:https");
  else if (plain && new URL(plain.finalUrl).protocol === "http:") {
    daily.push({ id: "site:https", text: "The site opens without the secure https address when typed with http.", fix: "Turn on the hosting's setting that sends http visitors to https.", who: "owner" });
  }
  const alt = live.startsWith("www.") ? live.slice(4) : `www.${live}`;
  // The other form not answering (no DNS record, no connection) means there is no second copy.
  if (!read || (other && (other.status >= 400 || other.partial))) kept("site:duplicate");
  else if (other && other.status < 300 && new URL(other.finalUrl).hostname.toLowerCase() === alt && pageTitle(other.text) && pageTitle(other.text) === pageTitle(read.text)) {
    // The same title on both: the site itself, not a host's default or parking page.
    daily.push({ id: "site:duplicate", text: `Both ${live} and ${alt} show the site, so Google can see two copies.`, fix: `Send ${alt} to ${live} with a permanent redirect in the hosting or domain settings.`, who: "owner" });
  }

  if (conn?.gscSiteUrl) {
    const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
    const site = encodeURIComponent(conn.gscSiteUrl);
    const maps = await googleRequest<{ sitemap?: { path?: string; errors?: string }[] }>(auth, `https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps`, undefined, {}, undefined, stop).catch(() => null);
    check();
    if (!maps) kept("site:sitemap");
    else {
      const list = maps.sitemap ?? [];
      const errors = list.reduce((a, m) => a + Number(m.errors ?? 0), 0);
      if (!list.length) {
        // Added when the site has one and the app may manage Search Console; otherwise the owner is told.
        const may = await hasScope(auth, "https://www.googleapis.com/auth/webmasters").catch(() => false);
        let added: string | null = null;
        for (const href of may ? sitemapCandidates(robotsRead?.text ?? null, conn.gscSiteUrl, live).slice(0, 3) : []) {
          const xml = await fetchText(href, 10_000, stop);
          if (!xml || xml.status >= 300 || xml.partial || !/<(urlset|sitemapindex)/i.test(xml.text)) continue;
          const ok = await googleRequest(auth, `https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps/${encodeURIComponent(href)}`, undefined, {}, "PUT", stop).then(
            () => true,
            (e) => (console.error(`sitemap not submitted for ${accountId}: ${(e as Error).message}`), false),
          );
          if (ok) {
            added = href;
            break;
          }
        }
        daily.push(
          added
            ? { id: "site:sitemap", text: "Search Console had no sitemap for this site.", fix: `Added ${added} to Search Console, so Google finds new pages sooner.`, who: "repaired" }
            : { id: "site:sitemap", text: "Search Console has no sitemap for this site.", fix: "Add the site's sitemap (usually /sitemap.xml) in Search Console, under Sitemaps.", who: "owner" },
        );
      } else if (errors > 0) {
        daily.push({ id: "site:sitemap", text: `Google found ${errors} ${errors === 1 ? "error" : "errors"} in the site's sitemap.`, fix: "Open Search Console, Sitemaps, to see which addresses fail, and fix or remove them.", who: "owner" });
      }
    }

    // Measurement: Analytics should count about the Google visits Search Console reports for the same host.
    if (conn.gaPropertyId) {
      const streams = await gaStreams(conn, stop).catch(() => null);
      const host = streams?.hosts[0] ?? live;
      const [clicks, ga] = await Promise.all([gscClicksForHost(conn, host, stop).catch(() => null), gaSessions(conn, stop).catch(() => null)]);
      check();
      if (!ga || clicks === null) kept("measure:stopped", "measure:gap");
      else if (ga.last3 === 0 && ga.all28 >= 140) {
        daily.push({
          id: "measure:stopped",
          text: `Google Analytics recorded no visits on the 3 days before yesterday, after ${ga.all28} visits in the 28 days from ${ga.from}.`,
          fix: "Check that the Analytics tag is still on the site and sends to the connected property.",
          who: "owner",
        });
      } else if (trackingGap(clicks, ga.google28)) {
        const why = read ? tagDiagnosis(tagIds(read.text), streams?.ids ?? null) : null;
        daily.push({
          id: "measure:gap",
          text: `Google Analytics counted ${ga.google28} visits from Google search in the 28 days from ${ga.from}, while Search Console counted ${clicks} clicks to ${host}. ${why?.cause ?? "The home page shows no reason; the tag may be missing on some pages, or blocked for some visitors."}`,
          fix: why?.fix ?? "Check that every page loads the Analytics tag for the connected property.",
          who: "owner",
        });
      }
      notes.push(`analytics ${ga ? ga.google28 : "unread"} vs search console ${clicks ?? "unread"}`);
    }
  }

  // The agents' title changes are really on the live pages (a theme can override them). Script applied ones are set
  // in the browser, so they are left out here.
  const changed = await sql`SELECT DISTINCT ON (c.page_url) c.page_url, c.after_value FROM insights_autopilot_changes c
    JOIN insights_autopilot_runs r ON r.id = c.run_id
    WHERE r.account_id = ${accountId} AND c.field = 'meta_title' AND c.status IN ('applied', 'kept') AND c.resource_type <> 'snippet'
      AND c.created_at < now() - interval '2 hours' AND c.created_at > now() - interval '30 days' AND coalesce(c.after_value, '') <> ''
    ORDER BY c.page_url, c.created_at DESC LIMIT 3`;
  const pages = await Promise.all(changed.map((c) => fetchText(String(c.page_url), 10_000, stop)));
  check();
  const missing = changed.filter((c, i) => pages[i] && pages[i]!.status < 300 && !pages[i]!.partial && !titleIsLive(pageTitle(pages[i]!.text), String(c.after_value))).map((c) => String(c.page_url));
  if (missing.length) {
    daily.push({
      id: "site:changes-not-live",
      text: `${missing.length} title ${missing.length === 1 ? "change an agent made doesn't" : "changes agents made don't"} show on the live ${missing.length === 1 ? "page" : "pages"}: ${missing.join(", ")}.`,
      fix: "The theme may set its own titles; the code repair run looks into it.",
      who: "watching",
      platform: true,
    });
  }

  // The weekly report reached the owner (when there is an owner address to send it to).
  const [wr] = await sql`SELECT s.value, coalesce(a.email_alerts, true) AS alerts, u.email FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'weekly_report:' || a.account_id
    LEFT JOIN insights_accounts u ON u.id = a.account_id
    WHERE a.account_id = ${accountId} AND a.enabled`;
  if (wr?.value && wr.email && !["false", "f"].includes(String(wr.alerts))) {
    const last = (() => {
      try {
        return JSON.parse(String(wr.value)) as { at?: string; sent?: boolean };
      } catch {
        return {};
      }
    })();
    if (last.sent === false) {
      daily.push({ id: "report:not-sent", text: "The last weekly report email couldn't be sent.", fix: "The email service or the owner's address needs a look; the status board shows which.", who: "watching", platform: true });
    } else if (last.at && Date.now() - Date.parse(last.at) > 9 * 24 * HOUR) {
      daily.push({ id: "report:late", text: "No weekly report has gone out in more than 9 days.", fix: "The code repair run looks at why the weekly report is not being sent.", who: "watching", platform: true });
    }
  }

  check();
  const now = new Date().toISOString();
  st.seen = Object.fromEntries(daily.map((p) => [p.id, keptIds.has(p.id) ? (st.seen[p.id] ?? st.dailyAt ?? now) : now]));
  st.daily = daily;
  st.dailyAt = now;
  notes.push(`daily checks: ${daily.length ? daily.map((d) => d.id).join(", ") : "all clear"}`);
}
