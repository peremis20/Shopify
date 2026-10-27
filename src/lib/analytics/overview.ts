import { resolveRange } from "./dates";
import { demoGa, demoGsc } from "./demo";
import { envGa4PropertyId, fetchGa4, ga4OpenUrl } from "./ga4";
import { getServiceAccount, oauthClient, type GoogleAuth } from "./google-auth";
import { envGscSiteUrl, fetchGsc, gscOpenUrl } from "./gsc";
import { buildIntegrations } from "./integrations";
import type { Connection } from "./connection";
import type { ConnectionInfo, OverviewResponse, PeriodRanges, RangeKey, SourceResult } from "./types";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: OverviewResponse }>();

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
  const oauthAvailable = Boolean(oauthClient());
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
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

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
  // Don't cache failures, so fixing a setting shows up on the next reload.
  if (ga.status !== "error" && gsc.status !== "error") {
    cache.set(cacheKey, { at: Date.now(), data });
  }
  return data;
}
