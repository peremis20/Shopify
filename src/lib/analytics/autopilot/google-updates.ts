import { ensureSchema, sql } from "../db";

/**
 * Google's own list of ranking updates (Search Status Dashboard). While one rolls out, and for two weeks after,
 * rankings swing for every site, so no change is judged (kept or undone) on them. Public facts: one shared cache.
 */
export interface GoogleUpdate {
  name: string;
  begin: string;
  /** Null while it is still rolling out. */
  end: string | null;
}

const FEED = "https://status.search.google.com/incidents.json";
const CACHE_KEY = "google_updates";
const CACHE_HOURS = 6;
/** Rankings keep moving for a while after Google says a rollout is complete. */
export const SETTLE_DAYS = 14;

export async function googleUpdates(): Promise<GoogleUpdate[]> {
  await ensureSchema();
  const [hit] = await sql`SELECT data FROM insights_report_cache WHERE cache_key = ${CACHE_KEY} AND fetched_at > now() - make_interval(hours => ${CACHE_HOURS})`;
  if (hit?.data) return JSON.parse(hit.data) as GoogleUpdate[];
  const res = await fetch(FEED, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Google's update list answered ${res.status}`);
  const raw = (await res.json()) as { external_desc?: string; begin?: string; end?: string | null; service_name?: string }[];
  const updates = parseUpdates(raw);
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${CACHE_KEY}, ${JSON.stringify(updates)}, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`;
  return updates;
}

/** Ranking updates from the feed; Discover updates don't move Google Search rankings, so they're left out. */
export function parseUpdates(raw: { external_desc?: string; begin?: string; end?: string | null; service_name?: string }[]): GoogleUpdate[] {
  return raw
    .filter((r) => r.service_name === "Ranking" && r.begin && r.external_desc && !/discover/i.test(r.external_desc))
    .map((r) => ({ name: r.external_desc!, begin: r.begin!, end: r.end ?? null }));
}

/** The update rolling out or still settling at `now`, if any. */
export function activeUpdate(updates: GoogleUpdate[], now = new Date()): { update: GoogleUpdate; settling: boolean } | null {
  for (const u of updates) {
    if (Date.parse(u.begin) > now.getTime()) continue;
    if (!u.end || Date.parse(u.end) > now.getTime()) return { update: u, settling: false };
    if (now.getTime() - Date.parse(u.end) < SETTLE_DAYS * 864e5) return { update: u, settling: true };
  }
  return null;
}

/** In plain words, why verdicts wait right now; null when Google is calm (or its list can't be read). */
export async function rankingTurbulence(): Promise<string | null> {
  const updates = await googleUpdates().catch((e) => {
    console.error(`google updates not read: ${(e as Error).message}`);
    return [] as GoogleUpdate[];
  });
  const a = activeUpdate(updates);
  if (!a) return null;
  const day = (iso: string) => iso.slice(0, 10);
  return a.settling
    ? `Google's ${a.update.name} finished on ${day(a.update.end!)} and rankings are still settling, so changes aren't judged until ${day(new Date(Date.parse(a.update.end!) + SETTLE_DAYS * 864e5).toISOString())}.`
    : `Google is rolling out its ${a.update.name} (since ${day(a.update.begin)}), so changes aren't judged until it settles.`;
}
