export type RangeKey = "7d" | "28d" | "90d" | "lastMonth";

/** Inclusive date range, both ends formatted as YYYY-MM-DD. */
export interface DateRange {
  start: string;
  end: string;
}

export interface PeriodRanges {
  current: DateRange;
  previous: DateRange;
}

/** A metric for the selected period alongside the period before it. */
export interface Delta {
  value: number;
  previous: number;
  /** Percent change vs. previous period, or null when there is nothing to compare. */
  change: number | null;
}

export interface GaData {
  totals: {
    users: Delta;
    pageViews: Delta;
    sessions: Delta;
    avgEngagementSec: Delta;
  };
  daily: { date: string; users: number; pageViews: number }[];
  channels: { name: string; sessions: number; share: number }[];
  topPages: { path: string; views: number; avgTimeSec: number }[];
}

export interface GscData {
  totals: {
    clicks: Delta;
    impressions: Delta;
    ctr: Delta;
    position: Delta;
  };
  daily: { date: string; clicks: number; impressions: number }[];
  topQueries: {
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
  topPages: { page: string; clicks: number; impressions: number }[];
}

export type SourceStatus = "live" | "demo" | "error";

export interface SourceResult<T> {
  status: SourceStatus;
  range: DateRange;
  data: T | null;
  error?: string;
  /** Deep link to the source tool for this property. */
  openUrl?: string;
}

export type IntegrationStatus =
  | "connected"
  | "demo"
  | "error"
  | "coming_soon";

export interface IntegrationInfo {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  detail?: string;
}

export interface ConnectionInfo {
  /** How data is pulled: a signed in Google account, a server service account, or not at all. */
  mode: "oauth" | "service_account" | "none";
  /** Whether "Connect with Google" is set up on the server. */
  oauthAvailable: boolean;
  /** Whether the Google Client ID and secret can be entered in Settings. */
  canSaveClient: boolean;
  /** The address to register in Google Cloud as the OAuth redirect URI. */
  redirectUri: string;
  email?: string;
  gaPropertyId?: string;
  gscSiteUrl?: string;
}

export interface PropertyOptions {
  ga: { items: { id: string; name: string; account: string }[]; error?: string };
  gsc: { items: string[]; error?: string };
}

export interface OverviewResponse {
  generatedAt: string;
  rangeKey: RangeKey;
  ga: SourceResult<GaData>;
  gsc: SourceResult<GscData>;
  connection: ConnectionInfo;
  integrations: IntegrationInfo[];
}
