import { resolveRange } from "./dates";
import { demoGa, demoGsc } from "./demo";
import { envGa4PropertyId, fetchGa4, ga4OpenUrl } from "./ga4";
import { getServiceAccount, type GoogleAuth } from "./google-auth";
import { envGscSiteUrl, fetchGsc, gscOpenUrl } from "./gsc";
import { buildIntegrations } from "./integrations";
import { signInAvailable, type Connection } from "./connection";
import { db, ensureSchema, hasDatabase } from "./db";
import type { ConnectionInfo, OverviewResponse, PeriodRanges, RangeKey, SourceResult } from "./types";

const CACHE_TTL_MS = 10 * 60 * 1000;
const memoryCache = new Map<string, { at: number; data: OverviewResponse }>();

/** Recent responses live in Neon when it's set up, so every server instance shares them. */
async function readCache(key: string): Promise<OverviewResponse | null> {
  if (!hasDatabase()) {
    const hit = memoryCache.get(key);
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.data : null;
  }
  await ensureSchema();
  const [row] = await db()`
    SELECT data FROM insights_report_cache
    WHERE cache_key = ${key} AND fetched_at > now() - make_interval(secs => ${CACHE_TTL_MS / 1000})`;
  return (row?.data as OverviewResponse) ?? null;
}

async function writeCache(key: string, data: OverviewResponse): Promise<void> {
  if (!hasDatabase()) {
    memoryCache.set(key, { at: Date.now(), data });
    return;
  }
  await db()`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at)
    VALUES (${key}, ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`;
}

function hasServiceAccount(): boolean {
  try {
    return Boolean(getServiceAccount());
  } catch {
    return true; // credentials are present but malformed, let the fetch report it
  }
}

interface Source {
  auth: GoogleAuth | null;
  gaId?: string;
  site?: string;
  info: ConnectionInfo;
}

/** A signed in Google account wins; otherwise fall back to a server service account. */
function resolveSource(conn: Connection | null): Source {
  const oauthAvailable = signInAvailable();
  if (conn && oauthAvailable) {
    return {
      auth: { kind: "oauth", refreshToken: conn.refreshToken },
      gaId: conn.gaPropertyId,
      site: conn.gscSiteUrl,
      info: { mode: "oauth", oauthAvailable, email: conn.email, gaPropertyId: conn.gaPropertyId, gscSiteUrl: conn.gscSiteUrl },
    };
  }
  if (hasServiceAccount()) {
    const gaId = envGa4PropertyId();
    const site = envGscSiteUrl();
    return {
      auth: { kind: "service_account" },
      gaId,
      site,
      info: { mode: "service_account", oauthAvailable, gaPropertyId: gaId, gscSiteUrl: site },
    };
  }
  return { auth: null, info: { mode: "none", oauthAvailable } };
}

async function load<T>(
  auth: GoogleAuth | null,
  id: string | undefined,
  missing: string,
  ranges: PeriodRanges,
  live: (auth: GoogleAuth, id: string, r: PeriodRanges) => Promise<T>,
  demo: (r: PeriodRanges) => T,
  openUrl: (id: string) => string
): Promise<SourceResult<T>> {
  if (!auth) {
    return { status: "demo", range: ranges.current, data: demo(ranges) };
  }
  if (!id) {
    return { status: "error", range: ranges.current, data: null, error: missing };
  }
  try {
    return { status: "live", range: ranges.current, data: await live(auth, id, ranges), openUrl: openUrl(id) };
  } catch (err) {
    return {
      status: "error",
      range: ranges.current,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      openUrl: openUrl(id),
    };
  }
}

export async function getOverview(
  rangeKey: RangeKey,
  conn: Connection | null,
  refresh = false
): Promise<OverviewResponse> {
  const source = resolveSource(conn);
  const cacheKey = [rangeKey, source.info.mode, conn?.email, source.gaId, source.site].join("|");
  if (!refresh) {
    const hit = await readCache(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  // GA4 is complete through yesterday; Search Console lags about 3 days.
  const [ga, gsc] = await Promise.all([
    load(source.auth, source.gaId, "Choose a Google Analytics property in Settings.",
      resolveRange(rangeKey, 1), fetchGa4, demoGa, ga4OpenUrl),
    load(source.auth, source.site, "Choose a Search Console property in Settings.",
      resolveRange(rangeKey, 3), fetchGsc, demoGsc, gscOpenUrl),
  ]);

  const data: OverviewResponse = {
    generatedAt: new Date().toISOString(),
    rangeKey,
    ga,
    gsc,
    connection: source.info,
    integrations: buildIntegrations({ ga: ga.status, gsc: gsc.status }),
  };
  // Sample data is cheap to rebuild, so only live results are stored.
  if (ga.status === "live" && gsc.status === "live") {
    await writeCache(cacheKey, data).catch(() => undefined);
  }
  return data;
}
