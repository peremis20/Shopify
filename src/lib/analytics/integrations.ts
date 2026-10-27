import type { IntegrationInfo, IntegrationStatus, SourceStatus } from "./types";

/**
 * Every app the dashboard knows about. To add a new one, write a fetcher next
 * to ga4.ts / gsc.ts, call it from overview.ts, then switch its entry here
 * from "coming_soon" to a live status.
 */
const CATALOG: Omit<IntegrationInfo, "status" | "detail">[] = [
  { id: "ga4", name: "Google Analytics", description: "Traffic, users and engagement" },
  { id: "gsc", name: "Google Search Console", description: "Search clicks, impressions and queries" },
  { id: "google-ads", name: "Google Ads", description: "Spend, conversions and ROAS" },
  { id: "meta", name: "Meta (Facebook / Instagram)", description: "Ad and social performance" },
  { id: "mailchimp", name: "Mailchimp", description: "Email opens, clicks and growth" },
  { id: "shopify", name: "Shopify", description: "Orders, revenue and products" },
];

const fromSource = (s: SourceStatus): IntegrationStatus => (s === "live" ? "connected" : s);

const DETAIL: Record<IntegrationStatus, string> = {
  connected: "Pulling live data",
  demo: "Showing sample data",
  error: "Connection problem",
  coming_soon: "Coming soon",
};

export function buildIntegrations(live: { ga: SourceStatus; gsc: SourceStatus }): IntegrationInfo[] {
  const statuses: Record<string, IntegrationStatus> = {
    ga4: fromSource(live.ga),
    gsc: fromSource(live.gsc),
  };
  return CATALOG.map((app) => {
    const status = statuses[app.id] ?? "coming_soon";
    return { ...app, status, detail: DETAIL[status] };
  });
}
