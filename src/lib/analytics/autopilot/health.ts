import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { toIso } from "../dates";
import { googleRequest } from "../google-auth";

/**
 * Technical health per page: whether Google has it indexed (URL Inspection),
 * which rich results it found and any problems with them, and how fast the
 * page is on a phone (PageSpeed Insights). Checks a few pages a day, oldest
 * first, so every important page is rechecked about once a week.
 */

export type IssueLevel = "high" | "medium" | "low";

export interface HealthIssue {
  level: IssueLevel;
  text: string;
  /** What to do about it, in plain words. */
  fix: string;
}

export interface PageHealth {
  url: string;
  checkedAt: string;
  indexed: boolean | null;
  coverage: string | null;
  lastCrawl: string | null;
  richResults: { type: string; issues: string[] }[];
  perfScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  issues: HealthIssue[];
  /** Opens this page in Search Console's URL inspection, where "Request indexing" lives. */
  inspectUrl: string;
}

const PAGES_PER_CHECK = 5;
const RECHECK_DAYS = 7;
const DAY = 86_400_000;

interface InspectionResult {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      pageFetchState?: string;
      lastCrawlTime?: string;
    };
    richResultsResult?: {
      verdict?: string;
      detectedItems?: { richResultType?: string; items?: { name?: string; issues?: { issueMessage?: string; severity?: string }[] }[] }[];
    };
  };
}

async function inspect(conn: Connection, url: string) {
  const r = await googleRequest<InspectionResult>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    { inspectionUrl: url, siteUrl: conn.gscSiteUrl }
  );
  const idx = r.inspectionResult?.indexStatusResult ?? {};
  const rich = (r.inspectionResult?.richResultsResult?.detectedItems ?? []).map((d) => ({
    type: d.richResultType ?? "Unknown",
    issues: (d.items ?? []).flatMap((i) => (i.issues ?? []).map((x) => `${x.severity === "ERROR" ? "Error" : "Warning"}: ${x.issueMessage ?? ""}`.trim())),
  }));
  return { idx, rich };
}

interface PsiResult {
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: Record<string, { numericValue?: number }>;
  };
  loadingExperience?: { metrics?: Record<string, { percentile?: number }> };
}

/** Mobile speed. Real visitor data (field) when Google has it, the lab test otherwise. */
async function pageSpeed(url: string, apiKey?: string) {
  const params = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (apiKey) params.set("key", apiKey);
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`PageSpeed ${res.status}`);
  const d = (await res.json()) as PsiResult;
  const field = d.loadingExperience?.metrics ?? {};
  const audits = d.lighthouseResult?.audits ?? {};
  const score = d.lighthouseResult?.categories?.performance?.score;
  const lcp = field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? audits["largest-contentful-paint"]?.numericValue;
  const clsField = field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
  const cls = clsField != null ? clsField / 100 : audits["cumulative-layout-shift"]?.numericValue;
  return {
    score: score == null ? null : Math.round(score * 100),
    lcpMs: lcp == null ? null : Math.round(lcp),
    cls: cls == null ? null : Math.round(cls * 100) / 100,
  };
}

const COVERAGE_FIX: [RegExp, string][] = [
  [/discovered/i, "Google knows the page but hasn't crawled it yet. Link to it from related pages and request indexing."],
  [/crawled/i, "Google crawled it but chose not to index it, usually because it looks thin or too similar to another page. Make it more useful and distinct, then request indexing."],
  [/noindex/i, "The page tells Google not to index it. Remove the noindex setting if you want it in search."],
  [/canonical|duplicate/i, "Google treats another page as the main version. Make this page distinct, or point its canonical tag at the page you want to rank."],
  [/redirect/i, "This old address forwards to another page, which is normal after renaming a product or post. Update any links that still use the old address."],
  [/404|not found/i, "The page returns not found. Restore it or redirect it to the closest page."],
];

function issuesFor(
  idx: NonNullable<NonNullable<InspectionResult["inspectionResult"]>["indexStatusResult"]>,
  rich: { type: string; issues: string[] }[],
  speed: { score: number | null; lcpMs: number | null; cls: number | null } | null
): HealthIssue[] {
  const out: HealthIssue[] = [];
  if (idx.verdict && idx.verdict !== "PASS") {
    const coverage = idx.coverageState ?? "Not indexed";
    // Redirects and alternate versions are usually on purpose (a renamed product, a variant URL).
    const expected = /redirect|alternate/i.test(coverage);
    out.push({
      level: expected ? "low" : "high",
      text: `Not in Google: ${coverage}.`,
      fix: COVERAGE_FIX.find(([re]) => re.test(coverage))?.[1] ?? "Check the page in Search Console and request indexing once it's fixed.",
    });
  }
  if (idx.robotsTxtState === "DISALLOWED") out.push({ level: "high", text: "Blocked by robots.txt.", fix: "Allow this address in your robots.txt file." });
  if (idx.pageFetchState && idx.pageFetchState !== "SUCCESSFUL" && idx.pageFetchState !== "PAGE_FETCH_STATE_UNSPECIFIED") {
    out.push({ level: "high", text: `Google couldn't load the page (${idx.pageFetchState.toLowerCase().replace(/_/g, " ")}).`, fix: "Make sure the page loads for visitors, then request indexing." });
  }
  if (idx.lastCrawlTime) {
    const days = Math.round((Date.now() - Date.parse(idx.lastCrawlTime)) / DAY);
    if (days > 60) out.push({ level: "low", text: `Google last crawled this page ${days} days ago.`, fix: "Link to it from newer pages; after changing it, request indexing." });
  }
  for (const r of rich) {
    for (const i of r.issues) out.push({ level: i.startsWith("Error") ? "medium" : "low", text: `${r.type}: ${i}`, fix: "Fix the structured data on this page so it can show as a rich result." });
  }
  if (speed?.score != null && speed.score < 50) {
    out.push({ level: "medium", text: `Slow on phones (speed score ${speed.score} of 100).`, fix: "Compress large images, remove apps and scripts you don't use, and keep the top of the page light." });
  }
  if (speed?.lcpMs != null && speed.lcpMs > 4000) {
    out.push({ level: "medium", text: `The main content takes ${(speed.lcpMs / 1000).toFixed(1)} seconds to appear on phones.`, fix: "Use a smaller first image and don't lazy load it; Google wants this under 2.5 seconds." });
  }
  if (speed?.cls != null && speed.cls > 0.25) {
    out.push({ level: "low", text: "The layout jumps while the page loads.", fix: "Give images and embeds a fixed size so content doesn't move." });
  }
  return out;
}

/** The pages worth watching: the ones Google sends the most visitors to, plus pages the autopilot changed. */
async function pagesToCheck(accountId: string, conn: Connection): Promise<string[]> {
  const end = new Date(Date.now() - 3 * DAY);
  const body = await googleRequest<{ rows?: { keys: string[]; clicks: number; impressions: number }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl!)}/searchAnalytics/query`,
    { startDate: toIso(new Date(end.getTime() - 27 * DAY)), endDate: toIso(end), dimensions: ["page"], rowLimit: 30 }
  ).catch(() => ({ rows: [] }));
  const top = (body.rows ?? []).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).map((r) => r.keys[0]);
  const changed = (await sql`SELECT DISTINCT page_url FROM insights_autopilot_changes WHERE account_id = ${accountId}`).map((r) => r.page_url!);
  return [...new Set([...changed, ...top])].filter((u) => !u.includes("#")).slice(0, 40);
}

/** Checks the few pages whose last check is oldest (or missing). Returns how many were checked. */
export async function checkHealth(accountId: string, conn: Connection, pagespeedKey?: string, limit = PAGES_PER_CHECK): Promise<number> {
  if (!conn.gscSiteUrl) return 0;
  await ensureSchema();
  const candidates = await pagesToCheck(accountId, conn);
  if (!candidates.length) return 0;
  const recent = new Set(
    (await sql`SELECT url FROM insights_page_health WHERE account_id = ${accountId}
      AND checked_at > now() - make_interval(days => ${RECHECK_DAYS})`).map((r) => r.url!)
  );
  const due = candidates.filter((u) => !recent.has(u)).slice(0, limit);
  await Promise.all(
    due.map(async (url) => {
      const [insp, speed] = await Promise.all([
        inspect(conn, url).catch(() => null),
        pageSpeed(url, pagespeedKey).catch(() => null),
      ]);
      if (!insp && !speed) return;
      const idx = insp?.idx ?? {};
      const rich = insp?.rich ?? [];
      const issues = issuesFor(idx, rich, speed);
      await sql`
        INSERT INTO insights_page_health (account_id, url, checked_at, index_verdict, coverage, last_crawl, rich_results, perf_score, lcp_ms, cls, issues)
        VALUES (${accountId}, ${url}, now(), ${idx.verdict ?? null}, ${idx.coverageState ?? null}, ${idx.lastCrawlTime ?? null},
          ${JSON.stringify(rich)}::jsonb, ${speed?.score ?? null}, ${speed?.lcpMs ?? null}, ${speed?.cls ?? null}, ${JSON.stringify(issues)}::jsonb)
        ON CONFLICT (account_id, url) DO UPDATE SET checked_at = now(), index_verdict = EXCLUDED.index_verdict, coverage = EXCLUDED.coverage,
          last_crawl = EXCLUDED.last_crawl, rich_results = EXCLUDED.rich_results,
          perf_score = COALESCE(EXCLUDED.perf_score, insights_page_health.perf_score),
          lcp_ms = COALESCE(EXCLUDED.lcp_ms, insights_page_health.lcp_ms),
          cls = COALESCE(EXCLUDED.cls, insights_page_health.cls), issues = EXCLUDED.issues`;
    })
  );
  return due.length;
}

const LEVEL_ORDER: Record<IssueLevel, number> = { high: 0, medium: 1, low: 2 };

export async function healthReport(accountId: string, conn: Connection | null): Promise<PageHealth[]> {
  await ensureSchema();
  const rows = await sql`SELECT * FROM insights_page_health WHERE account_id = ${accountId}`;
  const site = conn?.gscSiteUrl ?? "";
  return rows
    .map((r) => {
      const issues = (JSON.parse(r.issues ?? "[]") as HealthIssue[]).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
      return {
        url: r.url!,
        checkedAt: r.checked_at!,
        indexed: r.index_verdict ? r.index_verdict === "PASS" : null,
        coverage: r.coverage,
        lastCrawl: r.last_crawl,
        richResults: JSON.parse(r.rich_results ?? "[]"),
        perfScore: r.perf_score === null ? null : Number(r.perf_score),
        lcpMs: r.lcp_ms === null ? null : Number(r.lcp_ms),
        cls: r.cls === null ? null : Number(r.cls),
        issues,
        inspectUrl: `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(site)}&id=${encodeURIComponent(r.url!)}`,
      };
    })
    .sort((a, b) => (LEVEL_ORDER[a.issues[0]?.level] ?? 3) - (LEVEL_ORDER[b.issues[0]?.level] ?? 3) || a.url.localeCompare(b.url));
}

/** The latest health of one page, for the autopilot. */
export async function pageHealth(accountId: string, url: string): Promise<{ indexed: boolean | null; issues: HealthIssue[] } | null> {
  const [r] = await sql`SELECT index_verdict, issues FROM insights_page_health WHERE account_id = ${accountId} AND url = ${url}`;
  if (!r) return null;
  return { indexed: r.index_verdict ? r.index_verdict === "PASS" : null, issues: JSON.parse(r.issues ?? "[]") };
}

/** Accounts with the autopilot on whose pages haven't all been checked this week. Cheap: one query. */
export async function accountsDueForHealth(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    WHERE a.enabled AND NOT EXISTS (
      SELECT 1 FROM insights_page_health h WHERE h.account_id = a.account_id AND h.checked_at > now() - interval '20 hours')
    LIMIT ${limit}`;
  return rows.map((r) => r.account_id!);
}
