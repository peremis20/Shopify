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

export interface OverviewResponse {
  generatedAt: string;
  rangeKey: RangeKey;
  ga: SourceResult<GaData>;
  gsc: SourceResult<GscData>;
  integrations: IntegrationInfo[];
}
