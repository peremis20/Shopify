import { analytics } from "./analytics";
import { dailyRank } from "./daily-rank";
import { keywordPlanner } from "./keyword-planner";
import { pageOne } from "./page-one";
import { searchConsole } from "./search-console";
import { siteHealth } from "./site-health";
import { siteKeywords } from "./site-keywords";
import { targets } from "./targets";
import type { Hub, RankingApp } from "./types";

/** Every app the autopilot uses, in the order they run. Add new ones here. */
export const RANKING_APPS: RankingApp[] = [searchConsole, targets, siteKeywords, dailyRank, analytics, keywordPlanner, pageOne, siteHealth];

export async function readyApps(hub: Hub): Promise<RankingApp[]> {
  const ready = await Promise.all(RANKING_APPS.map((a) => Promise.resolve(a.ready(hub)).catch(() => false)));
  return RANKING_APPS.filter((_, i) => ready[i]);
}

export type { Brief, Candidate, Hub, Mode, RankingApp } from "./types";

export interface AppStatus {
  id: string;
  name: string;
  role: string;
  ready: boolean;
}

/** Which apps are feeding the autopilot for this account, for the Autopilot page. */
export async function appStatuses(hub: Hub): Promise<AppStatus[]> {
  const ready = await Promise.all(RANKING_APPS.map((a) => Promise.resolve(a.ready(hub)).catch(() => false)));
  return RANKING_APPS.map((a, i) => ({ id: a.id, name: a.name, role: a.role, ready: ready[i] }));
}
