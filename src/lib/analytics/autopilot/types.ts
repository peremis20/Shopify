/** Autopilot shapes shared by the server and the page. */

/**
 * "intent" records a content gap: the page can't give searchers what they want, so nothing was changed.
 * "link_fix" points links at a renamed product's live address instead of its redirect.
 */
export type ChangeField = "meta_title" | "meta_description" | "content" | "alt" | "internal_link" | "schema" | "intent" | "link_fix" | "new_article";
/** "suggested": on the fix list of a site the app can't edit, waiting to be pasted in. */
export type ChangeStatus = "applied" | "kept" | "reverted" | "failed" | "skipped" | "suggested";

export interface AutopilotChange {
  id: string;
  createdAt: string;
  pageUrl: string;
  query: string;
  field: ChangeField;
  before: string | null;
  after: string | null;
  reason: string | null;
  status: ChangeStatus;
  baselinePosition: number | null;
  resultPosition: number | null;
  evaluatedAt: string | null;
  note: string | null;
  /** For internal links: the article that received the link. */
  targetId: string | null;
}

export interface AutopilotRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  status: string;
  summary: string | null;
}

/** What the next run would change, without changing anything. */
export interface AutopilotPreview {
  page: string;
  query: string;
  mode: "defend" | "top" | "climb";
  position: number;
  monthlySearches: number | null;
  apps: string[];
  changes: { field: ChangeField; before: string | null; after: string }[];
  reason: string;
  notes: string[];
}
