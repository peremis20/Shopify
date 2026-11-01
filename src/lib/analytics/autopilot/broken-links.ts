import { lookup } from "node:dns/promises";
import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { bestPageIn, queryPageRows90d } from "../seo-tools";
import { readProspects, upsertProspects, type Prospect } from "./backlinks";
import { otherClient } from "./clients";
import { topicWords } from "./site-keywords";

/**
 * The Broken Link Agent. Once a week it reads health resource pages the
 * backlink finder found, checks the links on them, and when one is dead (the
 * page is gone: 404 or 410 on a real GET, or its whole domain no longer
 * exists) it finds this site's own page on that topic that already does best
 * on Google. That becomes a backlink prospect with a ready email: "your link
 * to X is broken, here's a working page on the same subject". The owner sends it.
 *
 * Careful by design:
 * - a link is dead only on a clear signal, never on a timeout or a site that
 *   blocks checks; a missing domain counts only when other links resolved fine
 *   in the same run and a second lookup fails too
 * - only public web addresses are fetched (no private, local or internal
 *   addresses, no odd ports), and every redirect is checked the same way
 * - the whole run has a time budget, and pages checked recently are skipped
 */

const KEY = (accountId: string) => `brokenlinks:${accountId}`;
/** Resource pages read per week, links checked per page, and in total. */
const PAGES = 6;
const LINKS_PER_PAGE = 40;
const MAX_CHECKS = 150;
/** The whole run stops here, saving what it found (keeps the hourly check on time). */
const BUDGET_MS = 75_000;
/** A page checked within this many days isn't read again. */
const RECHECK_DAYS = 60;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; DashPatrolLinkCheck/1.0)", Accept: "text/html,*/*" };

interface State {
  at: string;
  note: string;
  /** Pages read, by address, with when. */
  checked: Record<string, string>;
}

async function readState(accountId: string): Promise<State | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`.catch(() => [] as { value: string | null }[]);
  return row?.value ? (JSON.parse(row.value) as State) : null;
}

/** Records the run (also after a failure), so the site waits a week instead of holding up the queue. */
export async function markBrokenLinksChecked(accountId: string, note: string, checked?: Record<string, string>): Promise<void> {
  const prev = await readState(accountId).catch(() => null);
  const value: State = { at: new Date().toISOString(), note, checked: checked ?? prev?.checked ?? {} };
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(value)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
}

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

const SKIP_LINKS = /(^|\.)(facebook|instagram|twitter|x|tiktok|linkedin|pinterest|youtube|reddit|google|apple|amazon|bit\.ly|t\.co|wa\.me)\./i;

/** IPv4 and IPv6 addresses that aren't on the public internet. */
function privateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/** Only ordinary public web addresses: http or https, the usual ports, a real public hostname. */
async function isPublic(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  // No raw IP addresses, local names or internal suffixes.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return false;
  const addrs = await lookup(host, { all: true }).catch(() => null);
  // Doesn't resolve: public as far as we know (the dead domain check decides what that means).
  if (!addrs) return true;
  return addrs.every((a) => !privateIp(a.address));
}

/** A GET or HEAD that follows at most 3 redirects, checking every hop is a public address. Null when not allowed. */
async function safeFetch(href: string, method: "GET" | "HEAD", timeoutMs: number): Promise<Response | null> {
  let url = new URL(href);
  for (let hop = 0; hop <= 3; hop++) {
    if (!(await isPublic(url))) return null;
    const res = await fetch(url, { method, headers: UA, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    url = new URL(next, url);
  }
  return null;
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/gi, "&").replace(/&#38;/g, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

/** External content links on a page, with their link text. */
function linksOn(html: string, pageUrl: string, ourDomain: string): { href: string; anchor: string }[] {
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*?\shref=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(m[1]), pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const host = url.hostname.replace(/^www\./, "");
    if (host === pageHost || host === ourDomain || host.endsWith(`.${ourDomain}`) || SKIP_LINKS.test(`${host}.`)) continue;
    // A link to a site's home page isn't a page about a topic: nothing to replace it with.
    if (url.pathname === "/" || url.pathname === "") continue;
    const anchor = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (anchor.length < 4 || anchor.length > 120) continue;
    if (!out.has(url.href)) out.set(url.href, anchor);
  }
  return [...out].slice(0, LINKS_PER_PAGE).map(([href, anchor]) => ({ href, anchor }));
}

type Verdict = "dead" | "missing-domain" | "alive";

/** Dead only on a clear sign: a GET answered 404 or 410. A domain that doesn't resolve is reported separately. */
async function check(href: string): Promise<Verdict> {
  try {
    const head = await safeFetch(href, "HEAD", 7000);
    if (!head) return "alive"; // not ours to fetch: never call it dead
    if (head.status !== 404 && head.status !== 410 && head.status !== 405 && head.status !== 501 && head.status !== 403 && head.status !== 400) return "alive";
    // Some servers answer HEAD wrongly: only a GET decides.
    const get = await safeFetch(href, "GET", 8000);
    return get && (get.status === 404 || get.status === 410) ? "dead" : "alive";
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
    return code === "ENOTFOUND" ? "missing-domain" : "alive";
  }
}

export async function runBrokenLinks(accountId: string, conn: Connection | null, ourDomain: string): Promise<string> {
  const started = Date.now();
  const overBudget = () => Date.now() - started > BUDGET_MS;
  const state = await readState(accountId);
  const checkedPages: Record<string, string> = {};
  // Remember recent checks; forget old ones.
  for (const [u, at] of Object.entries(state?.checked ?? {})) if (Date.now() - Date.parse(at) < RECHECK_DAYS * 86_400_000) checkedPages[u] = at;

  const list = await readProspects(accountId);
  const sources = (list?.prospects ?? [])
    .filter((p) => (p.kind === "resource" || p.kind === "guest") && p.status === "new" && !checkedPages[p.url])
    .sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0))
    .slice(0, PAGES);
  if (!sources.length || !conn?.gscSiteUrl) {
    const note = sources.length ? "no Search Console to pick a replacement page" : "no new resource pages to check";
    await markBrokenLinksChecked(accountId, note, checkedPages);
    return note;
  }
  const isOther = await otherClient(ourDomain);
  // The site's Search Console data, read once and matched in memory.
  const rows = await queryPageRows90d(conn).catch(() => []);
  const found: Prospect[] = [];
  let checks = 0;
  let resolvedOk = 0;

  for (const page of sources) {
    if (checks >= MAX_CHECKS || overBudget()) break;
    checkedPages[page.url] = new Date().toISOString();
    const res = await safeFetch(page.url, "GET", 9000).catch(() => null);
    if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("html")) continue;
    const html = (await res.text().catch(() => "")).slice(0, 2_000_000);
    const links = linksOn(html, page.url, ourDomain)
      .filter((l) => !isOther(new URL(l.href).hostname))
      .slice(0, MAX_CHECKS - checks);
    checks += links.length;
    const dead: { href: string; anchor: string; missing: boolean }[] = [];
    // A few at a time, to stay polite.
    for (let i = 0; i < links.length && !overBudget(); i += 8) {
      const batch = links.slice(i, i + 8);
      const verdicts = await Promise.all(batch.map((l) => check(l.href)));
      batch.forEach((l, j) => {
        if (verdicts[j] === "alive") resolvedOk++;
        else dead.push({ ...l, missing: verdicts[j] === "missing-domain" });
      });
    }
    // The first dead link we can offer a real replacement for (this site's best page on its subject).
    for (const d of dead) {
      if (d.missing) {
        // A missing domain counts only if other links resolved fine and it still fails a moment later.
        if (resolvedOk < 3) continue;
        const again = await lookup(new URL(d.href).hostname).then(() => true).catch(() => false);
        if (again) continue;
      }
      let path = "";
      try {
        path = decodeURIComponent(new URL(d.href).pathname);
      } catch {
        path = new URL(d.href).pathname;
      }
      const words = [...topicWords(`${d.anchor} ${path.replace(/[-_/]+/g, " ")}`)].slice(0, 4);
      const best = bestPageIn(rows, words) ?? bestPageIn(rows, [...topicWords(page.topic)]);
      if (!best) continue;
      found.push({ ...page, kind: "broken", brokenLink: d.href, anchor: d.anchor, ourPage: best.page, foundAt: new Date().toISOString() });
      break;
    }
  }
  if (found.length) await upsertProspects(accountId, found);
  const note = `${found.length} broken ${found.length === 1 ? "link" : "links"} found (${checks} links checked)${overBudget() ? ", stopped at the time limit" : ""}`;
  await markBrokenLinksChecked(accountId, note, checkedPages);
  return note;
}
