import { sql } from "../db";

/**
 * How every weekly per site agent run starts and ends (the Store audit, the Journalists agent, Media requests):
 * - it rests in the Sabbath and while the autopilot is paused;
 * - a provisional marker is saved before the work starts, so a killed run comes back in a day instead of blocking
 *   the queue, and the real marker on every exit;
 * - the status board hears how it went: working, or not working with a plain reason. A normal wait is not reported.
 * - the owner only ever reads plain words; the raw error goes to the logs and the status board detail.
 */

export interface RunOutcome {
  note: string;
  /** A normal wait (nothing to do yet, not a store, not shown to be the account's): reported neither way. */
  skip?: boolean;
  retryInDays?: number;
  /** Something the Inspector must see, in plain words: reported as not working. */
  problem?: string;
}

export interface WeeklyDeps {
  sabbath: () => boolean;
  autopilotOn: () => Promise<boolean>;
  mark: (note: string, retryInDays?: number) => Promise<void>;
  report: (ok: boolean, detail: string | null) => Promise<void> | void;
  work: () => Promise<RunOutcome>;
  /** The owner's words for a failure. */
  plainFailure: (e: unknown) => string;
  /** The agent's name for the owner, e.g. "Store audit". */
  name: string;
  started: string;
}

export async function runWeekly(d: WeeklyDeps): Promise<string> {
  const mark = (note: string, days?: number) => d.mark(note, days).catch((e) => console.error(`${d.name} not marked: ${(e as Error).message}`));
  if (d.sabbath()) {
    await mark(`${d.name} rests for the Sabbath.`, 1);
    return `${d.name} rests for the Sabbath.`;
  }
  try {
    if (!(await d.autopilotOn())) {
      await mark(`${d.name} skipped: the autopilot is paused.`);
      return `${d.name} skipped: the autopilot is paused.`;
    }
    await mark(d.started, 1);
    const r = await d.work();
    await mark(r.note, r.retryInDays);
    if (r.problem) await d.report(false, r.problem);
    else if (!r.skip) await d.report(true, null);
    return r.note;
  } catch (e) {
    const plain = d.plainFailure(e);
    console.error(`${d.name} failed: ${(e as Error)?.message ?? e}`);
    await mark(plain);
    await d.report(false, `${plain} (${String((e as Error)?.message ?? e).slice(0, 200)})`);
    return plain;
  }
}

/**
 * Saves a run marker in insights_settings. Its updated_at decides when the site is due again: a short wait comes back
 * in `retryInDays`, the usual one in a week.
 */
export async function saveRunMarker(key: string, note: string, retryInDays = 7): Promise<void> {
  const back = Math.max(0, 7 - retryInDays);
  await sql`
    INSERT INTO insights_settings (key, value, updated_at) VALUES (${key}, ${JSON.stringify({ at: new Date().toISOString(), note })}, now() - make_interval(days => ${back}))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
}

/** The note saved in a run marker, or null. */
export async function readRunNote(key: string): Promise<string | null> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key}`.catch(() => [] as { value: string | null }[]);
  try {
    return row?.value ? ((JSON.parse(String(row.value)) as { note?: string }).note ?? null) : null;
  } catch {
    return null;
  }
}

/** Sites with the autopilot on and an address whose weekly run (marker `<prefix>:<account>`) is due. */
export async function accountsDueWeekly(prefix: string, limit: number): Promise<string[]> {
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    JOIN insights_account_profile p ON p.account_id = a.account_id
    LEFT JOIN insights_settings s ON s.key = ${`${prefix}:`} || a.account_id::text
    WHERE a.enabled AND coalesce(p.site_domain, '') <> '' AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}
