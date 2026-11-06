import { ensureSchema, sql } from "../db";

/**
 * A shared status board. Every outside service the agents depend on reports
 * here when it works and when it fails, so the Inspector (inspector.ts) can
 * see a broken part right away, even when the failure was quiet, and tell the
 * other agents to work around it or tell the owner what to do.
 */

export type Part = "openpagerank" | "serper" | "ai" | "ai-review" | "keyword-planner" | "email" | "share-kit" | "idea-finder" | "keywords-everywhere" | "outreach-drafter";

export interface PartStatus {
  ok: boolean;
  at: string;
  /** The last time it worked. */
  lastOk: string | null;
  /** What went wrong, in the service's own words. */
  detail: string | null;
  failures: number;
}

const KEY = "status:platform";
let cache: { at: number; value: Record<string, PartStatus> } | null = null;

export async function readStatus(): Promise<Partial<Record<Part, PartStatus>>> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY}`.catch(() => [] as { value: string | null }[]);
  const value = row?.value ? (JSON.parse(row.value) as Record<string, PartStatus>) : {};
  cache = { at: Date.now(), value };
  return value;
}

/** Records how a call to a service went. Cheap: only writes when the state changes or once a minute. */
export async function report(part: Part, ok: boolean, detail: string | null = null): Promise<void> {
  try {
    const all = await readStatus();
    const cur = all[part];
    const now = new Date().toISOString();
    if (cur && cur.ok === ok && Date.now() - Date.parse(cur.at) < 60_000) return;
    const next: PartStatus = {
      ok,
      at: now,
      lastOk: ok ? now : (cur?.lastOk ?? null),
      detail: ok ? null : (detail ?? cur?.detail ?? null)?.slice(0, 600) ?? null,
      failures: ok ? 0 : (cur?.failures ?? 0) + 1,
    };
    const value = { ...all, [part]: next };
    cache = { at: Date.now(), value };
    await sql`
      INSERT INTO insights_settings (key, value) VALUES (${KEY}, ${JSON.stringify(value)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  } catch {
    // The status board must never break the work it watches.
  }
}
