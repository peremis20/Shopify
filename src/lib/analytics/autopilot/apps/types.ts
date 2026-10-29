import type { Connection } from "../../connection";
import type { Opportunity } from "../../seo-types";
import type { PlatformSettings } from "../settings";

/**
 * The autopilot's apps. Each connected service (Search Console, Analytics,
 * Keyword Planner, Google page one, and whatever comes next) plugs in here and
 * can do up to three things:
 *
 * - candidates: suggest pages and searches to work on
 * - enrich:     add facts and score weights to every candidate (from all apps)
 * - brief:      tell the writer what it knows about the chosen target
 *
 * Apps share what they learn through `hub.shared`, and run in registry order,
 * so a later app can build on an earlier one. To add a new API, write one file
 * that exports a RankingApp and add it to the list in ./index.ts.
 */

export type Mode = "defend" | "top" | "climb";

export interface Candidate {
  op: Opportunity & { monthlySearches?: number };
  mode: Mode;
  /** For "defend": the average position before it slipped. */
  previousPosition?: number;
  /** Score multipliers by app id; the final score multiplies them all. */
  weights: Record<string, number>;
}

export interface Hub {
  accountId: string;
  conn: Connection;
  platform: PlatformSettings;
  /** The store's domain, e.g. "peremis.com". */
  ourDomain: string;
  /** Anything one app learns that another can use, keyed by "<app id>.<name>". */
  shared: Map<string, unknown>;
}

export interface Brief {
  /** Instructions and facts for the writer. */
  text: string;
  /** A short note for the run summary, if any. */
  summary?: string;
}

export interface RankingApp {
  id: string;
  name: string;
  /** One line on what it adds, shown on the Autopilot page. */
  role: string;
  /** Whether it's set up for this account. Apps that aren't ready are skipped. */
  ready(hub: Hub): Promise<boolean> | boolean;
  candidates?(hub: Hub): Promise<Candidate[]>;
  enrich?(hub: Hub, cands: Candidate[]): Promise<void>;
  brief?(hub: Hub, c: Candidate): Promise<Brief | null>;
}

export const keyOf = (o: { query: string; page: string }) => `${o.query}\n${o.page}`;
export const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
