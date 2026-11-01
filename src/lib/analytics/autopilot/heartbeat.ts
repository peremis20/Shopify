import { ensureSchema, sql } from "../db";
import { isSabbath } from "./sabbath";

/**
 * The hourly run's heartbeat. Every run writes when it started and how it
 * ended, so a watcher outside Neon (and anyone hitting /api/heartbeat) can tell
 * when the hourly run stopped happening, got stuck, or keeps failing. The
 * Inspector lives inside that run, so it can never notice its own absence.
 */

export interface Heartbeat {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
  sabbath: boolean;
  /** Runs in a row that ended in an error. */
  failures: number;
}

const KEY = "heartbeat";
const HOUR = 3_600_000;

export async function readHeartbeat(): Promise<Heartbeat | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY}`;
  return row?.value ? (JSON.parse(String(row.value)) as Heartbeat) : null;
}

async function write(hb: Heartbeat): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY}, ${JSON.stringify(hb)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * Called when a run begins; returns its start time, which heartbeatEnd needs.
 * A previous run that never finished (killed by a time limit or a crash) counts
 * as a failure here, since it never got to say so itself. Never throws.
 */
export async function heartbeatStart(sabbath: boolean): Promise<string> {
  const startedAt = new Date().toISOString();
  try {
    const prev = await readHeartbeat();
    const killed = Boolean(prev && !prev.finishedAt && !sabbath);
    await write({
      startedAt,
      finishedAt: null,
      ok: null,
      error: killed ? "The last run never finished." : null,
      sabbath,
      failures: killed ? prev!.failures + 1 : (prev?.failures ?? 0),
    });
  } catch (e) {
    console.error(`heartbeat not written: ${e instanceof Error ? e.message : e}`);
  }
  return startedAt;
}

/**
 * Called when a run ends, with the error that ended it, if any. Only the run
 * that wrote the current record may close it: a slow run that overlaps the
 * next one must not mark the newer one finished.
 */
export async function heartbeatEnd(startedAt: string, error: string | null): Promise<void> {
  try {
    const cur = await readHeartbeat();
    if (!cur || cur.startedAt !== startedAt) return;
    await write({ ...cur, finishedAt: new Date().toISOString(), ok: !error, error: error?.slice(0, 400) ?? null, failures: error ? cur.failures + 1 : 0 });
  } catch (e) {
    console.error(`heartbeat not written: ${e instanceof Error ? e.message : e}`);
  }
}

export interface Verdict {
  ok: boolean;
  /** Plain words for the owner. */
  text: string;
}

/**
 * Is the hourly run healthy? The text is public (no error details, which can
 * hold internal values). Missing for over two hours, stuck for over an
 * hour, or failing twice in a row is not. During the Sabbath, and in the two
 * hours after it ends, a quiet run is expected.
 */
export function judgeHeartbeat(hb: Heartbeat | null, now = new Date()): Verdict {
  if (isSabbath(now) || isSabbath(new Date(now.getTime() - 2 * HOUR))) return { ok: true, text: "Resting for the Sabbath." };
  if (!hb) return { ok: false, text: "The hourly run has never reported in." };
  const started = Date.parse(hb.startedAt);
  const age = now.getTime() - started;
  // A little past two hours, so one skipped run doesn't flicker an alarm just before the next one starts.
  if (age > 2 * HOUR + 10 * 60_000) return { ok: false, text: `The hourly run hasn't happened in ${Math.round(age / HOUR)} hours.` };
  if (!hb.finishedAt && age > HOUR) return { ok: false, text: "The hourly run started but never finished." };
  if (hb.failures >= 2) return { ok: false, text: `The hourly run failed ${hb.failures} times in a row.` };
  return { ok: true, text: "The hourly run is working." };
}
