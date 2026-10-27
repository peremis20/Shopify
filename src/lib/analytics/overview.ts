import { resolveRange } from "./dates";
import { demoGa, demoGsc } from "./demo";
import { fetchGa4, ga4OpenUrl, ga4PropertyId } from "./ga4";
import { getServiceAccount } from "./google-auth";
import { fetchGsc, gscOpenUrl, gscSiteUrl } from "./gsc";
import { buildIntegrations } from "./integrations";
import type { OverviewResponse, PeriodRanges, RangeKey, SourceResult } from "./types";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<RangeKey, { at: number; data: OverviewResponse }>();

function hasCredentials(): boolean {
  try {
    return Boolean(getServiceAccount());
  } catch {
    return true; // credentials are present but malformed, let the fetch report it
  }
}

async function load<T>(
  configured: boolean,
  ranges: PeriodRanges,
  live: (r: PeriodRanges) => Promise<T>,
  demo: (r: PeriodRanges) => T,
  openUrl?: string
): Promise<SourceResult<T>> {
  if (!configured) {
    return { status: "demo", range: ranges.current, data: demo(ranges) };
  }
  try {
    return { status: "live", range: ranges.current, data: await live(ranges), openUrl };
  } catch (err) {
    return {
      status: "error",
      range: ranges.current,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      openUrl,
    };
  }
}

export async function getOverview(rangeKey: RangeKey, refresh = false): Promise<OverviewResponse> {
  const hit = cache.get(rangeKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const creds = hasCredentials();
  // GA4 is complete through yesterday; Search Console lags about 3 days.
  const [ga, gsc] = await Promise.all([
    load(creds && !!ga4PropertyId(), resolveRange(rangeKey, 1), fetchGa4, demoGa, ga4OpenUrl()),
    load(creds && !!gscSiteUrl(), resolveRange(rangeKey, 3), fetchGsc, demoGsc, gscOpenUrl()),
  ]);

  const data: OverviewResponse = {
    generatedAt: new Date().toISOString(),
    rangeKey,
    ga,
    gsc,
    integrations: buildIntegrations({ ga: ga.status, gsc: gsc.status }),
  };
  // Don't cache failures, so fixing a setting shows up on the next reload.
  if (ga.status !== "error" && gsc.status !== "error") {
    cache.set(rangeKey, { at: Date.now(), data });
  }
  return data;
}
