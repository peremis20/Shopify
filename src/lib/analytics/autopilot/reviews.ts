import { ensureSchema, sql } from "../db";

/**
 * What the second agents suggest while checking each piece of work, kept per site so the
 * Strategist can learn from it. These are opinions, never data: the Strategist reads them
 * apart from its facts.
 */
export interface ReviewNote {
  at: string;
  /** Which agent's work was checked: "page change", "new article", "outreach email", "backlink sites". */
  agent: string;
  note: string;
}

const KEY = (accountId: string) => `review_notes:${accountId}`;
const KEEP = 30;

export async function readReviewNotes(accountId: string): Promise<ReviewNote[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as ReviewNote[]) : [];
}

/** Adds the reviewer's suggestions (blank ones and repeats are ignored), newest first. */
export async function recordReviewNotes(accountId: string, agent: string, notes: (string | null | undefined)[]): Promise<void> {
  const fresh = notes.map((n) => (n ?? "").trim()).filter((n) => n.length > 10);
  if (!fresh.length) return;
  const old = await readReviewNotes(accountId).catch(() => []);
  const seen = new Set(old.map((o) => o.note.toLowerCase()));
  const add = fresh.filter((n) => !seen.has(n.toLowerCase())).map((note) => ({ at: new Date().toISOString(), agent, note }));
  if (!add.length) return;
  const all = [...add, ...old].slice(0, KEEP);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(all)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
