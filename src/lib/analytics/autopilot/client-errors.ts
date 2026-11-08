import { sql } from "../db";

/**
 * What broke in owners' browsers (script errors, failed requests, a page wider than the screen, a page that crashed
 * while drawing), kept per account so the App checker and the code repair agent see it. Only the app's own problem
 * text and where it happened are kept, never page content.
 */

export interface ClientError {
  kind: "script" | "promise" | "request" | "layout" | "render";
  message: string;
  where: string;
  width: number | null;
  first: string;
  last: string;
  count: number;
}

const KINDS = new Set(["script", "promise", "request", "layout", "render"]);
const KEY = (who: string) => `client_errors:${who}`;
/** Errors from browser extensions and the like, not the app's own code. Failed app requests are always kept. */
const NOISE = /ResizeObserver loop|extension:\/\/|Script error\.?$|Non-Error promise rejection|^Load failed$|NetworkError when attempting|Failed to fetch$/i;
/** New errors kept per account per hour, so one browser (or someone on purpose) can't flood the record. */
const PER_HOUR = 15;

export function cleanReport(body: unknown): Pick<ClientError, "kind" | "message" | "where" | "width"> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const kind = String(b.kind ?? "");
  const message = String(b.message ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!KINDS.has(kind) || !message || (kind !== "request" && NOISE.test(message))) return null;
  const width = Number(b.width);
  return { kind: kind as ClientError["kind"], message, where: String(b.where ?? "").slice(0, 120), width: Number.isFinite(width) ? Math.round(width) : null };
}

export async function readClientErrors(who: string): Promise<ClientError[]> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(who)}`.catch(() => [] as { value: string | null }[]);
  try {
    return row?.value ? (JSON.parse(row.value) as ClientError[]) : [];
  } catch {
    return [];
  }
}

/** Adds one report: the same error again only raises its count. At most 40 kept, the newest. */
export async function saveClientError(who: string, report: NonNullable<ReturnType<typeof cleanReport>>): Promise<void> {
  const list = await readClientErrors(who);
  const now = new Date().toISOString();
  const same = list.find((e) => e.kind === report.kind && e.message === report.message && e.where === report.where);
  if (same) {
    // A burst from one page load is counted once a minute, so one browser can't flood the record.
    if (Date.now() - Date.parse(same.last) < 60_000) return;
    same.count++;
    same.last = now;
    same.width = report.width;
  } else {
    if (list.filter((e) => Date.now() - Date.parse(e.first) < 3_600_000).length >= PER_HOUR) return;
    list.push({ ...report, first: now, last: now, count: 1 });
  }
  const kept = list.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 40);
  await sql`INSERT INTO insights_settings (key, value) VALUES (${KEY(who)}, ${JSON.stringify(kept)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
