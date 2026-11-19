import { ensureSchema, sql } from "../db";

/**
 * The team board: one shared page per site where every agent writes what it did, what it found, what it needs from
 * the owner, and work it hands to another agent. Every agent reads it, so they all work from the same picture:
 * the Strategist plans from it, the Inspector watches it, the weekly report shows it to the owner, and an agent
 * picks up the work handed to it.
 *
 * The status board (status.ts) says whether a service works. This board says what the team is doing on each site,
 * and it holds that site's own work only.
 */

export type TeamKind = "did" | "found" | "needs" | "handoff";

export interface TeamNote {
  id: string;
  agent: string;
  kind: TeamKind;
  to: string | null;
  text: string;
  at: string;
  done: boolean;
}

const KINDS: TeamKind[] = ["did", "found", "needs", "handoff"];
const clean = (v: string, n: number) => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

let ready: Promise<void> | null = null;
function schema(): Promise<void> {
  ready ??= (async () => {
    await ensureSchema();
    await sql`CREATE TABLE IF NOT EXISTS insights_team_notes (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      agent text NOT NULL,
      kind text NOT NULL,
      to_agent text,
      text text NOT NULL,
      ref text,
      created_at timestamptz NOT NULL DEFAULT now(),
      done_at timestamptz
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_team_notes_account ON insights_team_notes (account_id, created_at DESC)`;
    // A note with a ref is written once (the same week's run, the same won deal), however often its agent runs.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS insights_team_notes_ref ON insights_team_notes (account_id, agent, ref) WHERE ref IS NOT NULL`;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/**
 * Writes a note on the site's board. Never throws: the board must not break the work it records.
 * A note with a `ref` is kept as one note that is brought up to date (a weekly total, a problem still open), so an
 * agent running every hour doesn't fill the board. Notes hold business facts only, never a person's email or phone.
 */
export async function postNote(
  accountId: string,
  agent: string,
  kind: TeamKind,
  text: string,
  opts: { to?: string; ref?: string } = {},
): Promise<void> {
  try {
    const t = clean(text, 500);
    if (!t || !KINDS.includes(kind) || !/^\d{1,18}$/.test(accountId)) return;
    await schema();
    const ref = opts.ref ? clean(opts.ref, 200) : null;
    const to = opts.to ? clean(opts.to, 60) : null;
    await sql`INSERT INTO insights_team_notes (account_id, agent, kind, to_agent, text, ref)
      VALUES (${accountId}, ${clean(agent, 60)}, ${kind}, ${to}, ${t}, ${ref})
      ON CONFLICT (account_id, agent, ref) WHERE ref IS NOT NULL DO UPDATE
        SET text = EXCLUDED.text, kind = EXCLUDED.kind, to_agent = EXCLUDED.to_agent,
          created_at = CASE WHEN insights_team_notes.text = EXCLUDED.text THEN insights_team_notes.created_at ELSE now() END,
          done_at = CASE WHEN EXCLUDED.kind = 'needs' THEN NULL ELSE insights_team_notes.done_at END`;
  } catch (e) {
    console.error(`team note not saved: ${(e as Error)?.message ?? e}`);
  }
}

/** A "needs" note that no longer applies (the owner fixed it) is closed, so the board only shows what is still open. */
export async function closeNeed(accountId: string, agent: string, ref: string): Promise<void> {
  try {
    await schema();
    await sql`UPDATE insights_team_notes SET done_at = now()
      WHERE account_id = ${accountId} AND agent = ${agent} AND ref = ${ref} AND kind = 'needs' AND done_at IS NULL`;
  } catch {
    /* the board must not break the work */
  }
}

/**
 * What one agent needs from the owner right now: each item is posted (or kept), and that agent's other open needs are
 * closed, because they were fixed.
 */
export async function syncNeeds(accountId: string, agent: string, items: { ref: string; text: string }[]): Promise<void> {
  for (const i of items) await postNote(accountId, agent, "needs", i.text, { ref: i.ref });
  try {
    await schema();
    const refs = items.map((i) => clean(i.ref, 200)).join("\n");
    await sql`UPDATE insights_team_notes SET done_at = now()
      WHERE account_id = ${accountId} AND agent = ${agent} AND kind = 'needs' AND done_at IS NULL
        AND NOT (ref = ANY(string_to_array(${refs}, E'\n')))`;
  } catch {
    /* the board must not break the work */
  }
}

/** Work handed to an agent and not picked up yet, oldest first. */
export async function handoffsFor(accountId: string, agent: string, limit = 20): Promise<TeamNote[]> {
  await schema();
  const rows = await sql`SELECT * FROM insights_team_notes
    WHERE account_id = ${accountId} AND kind = 'handoff' AND to_agent = ${agent} AND done_at IS NULL
      AND created_at > now() - interval '30 days'
    ORDER BY created_at LIMIT ${limit}`;
  return rows.map(toNote);
}

export async function markPickedUp(accountId: string, id: string): Promise<void> {
  await schema();
  await sql`UPDATE insights_team_notes SET done_at = now() WHERE id = ${id} AND account_id = ${accountId}`;
}

const toNote = (r: Record<string, unknown>): TeamNote => ({
  id: String(r.id),
  agent: String(r.agent),
  kind: r.kind as TeamKind,
  to: (r.to_agent as string | null) ?? null,
  text: String(r.text),
  at: new Date(r.created_at as string).toISOString(),
  done: Boolean(r.done_at),
});

/** The site's board: open needs first, then the last `days` days of notes, newest first. */
export async function readBoard(accountId: string, days = 7, limit = 60): Promise<TeamNote[]> {
  await schema();
  const rows = await sql`SELECT * FROM insights_team_notes
    WHERE account_id = ${accountId}
      AND ((kind = 'needs' AND done_at IS NULL) OR created_at > now() - make_interval(days => ${days}::int))
    ORDER BY (kind = 'needs' AND done_at IS NULL) DESC, created_at DESC LIMIT ${limit}`;
  return rows.map(toNote);
}

/**
 * The board as plain lines for the Strategist and its critic: each agent's latest notes this week, and what still
 * needs the owner. Pure, so it is tested.
 */
export function boardFacts(notes: TeamNote[], perAgent = 3): string[] {
  const lines: string[] = [];
  const needs = notes.filter((n) => n.kind === "needs" && !n.done);
  if (needs.length) lines.push("Waiting on the owner (team board): " + needs.slice(0, 6).map((n) => `${n.agent}: ${n.text}`).join(" | "));
  const byAgent = new Map<string, TeamNote[]>();
  for (const n of notes) {
    if (n.kind === "needs") continue;
    const list = byAgent.get(n.agent) ?? [];
    if (list.length < perAgent) list.push(n);
    byAgent.set(n.agent, list);
  }
  for (const [agent, list] of byAgent) {
    lines.push(`Team board, ${agent} this week: ` + list.map((n) => (n.kind === "handoff" && n.to ? `handed to ${n.to}: ${n.text}` : n.text)).join(" | "));
  }
  return lines;
}

/** Notes older than 120 days are removed (open needs stay). */
export async function pruneBoard(): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_team_notes WHERE created_at < now() - interval '120 days' AND NOT (kind = 'needs' AND done_at IS NULL)`;
}
