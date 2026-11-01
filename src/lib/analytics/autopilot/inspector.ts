import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { readAccountAutopilot, readPlatformSettings } from "./settings";
import { readStatus, type Part } from "./status";
import { trackRanks } from "./tracking";
import { isSabbath } from "./sabbath";

/**
 * The Inspector: the agent that checks on the others. Every hour it looks for
 * anything broken, stuck or quietly failing, repairs what an agent can repair
 * on its own (it tells that agent to run again, or the others to work around
 * a broken service), and reports in plain words what only a person can fix.
 */

export interface Problem {
  id: string;
  /** What's wrong, in plain words. */
  text: string;
  /** What to do, or what the agents already did about it. */
  fix: string;
  /** "owner": needs a person. "repaired": an agent fixed it. "watching": agents are working around it. */
  who: "owner" | "repaired" | "watching";
  /** Platform keys and services: only the platform owner can act on these. */
  platform?: boolean;
}

const HOUR = 3_600_000;

const PART_FIX: Record<Part, { name: string; fix: (detail: string) => string; workaround: string }> = {
  openpagerank: {
    name: "Open PageRank (site strength)",
    fix: (d) =>
      /keywordseverywhere|DomCop|moved/i.test(d)
        ? "The saved key is an old one. Create a free key at openpagerank.keywordseverywhere.com and paste it in Platform keys."
        : "Check the Open PageRank key in Platform keys.",
    workaround: "Until then, difficulty scores judge page 1 by the list of big publishers instead.",
  },
  serper: {
    name: "Google page 1 lookups (serper.dev)",
    fix: (d) => (/credit|quota|limit|402|429/i.test(d) ? "The serper.dev credits ran out. Top up or upgrade at serper.dev." : "Check the serper.dev key in Platform keys."),
    workaround: "Rank checks, difficulty scores and backlink searches pause until it works again; cached results are used meanwhile.",
  },
  ai: {
    name: "The writing AI",
    fix: () => "Every AI key failed. Check the keys and their billing in Platform keys.",
    workaround: "No new changes or articles are written until one works.",
  },
  "keyword-planner": {
    name: "Google Keyword Planner",
    fix: () => "Reconnect Google Ads under Keyword ideas.",
    workaround: "Keyword ideas pause; the current keyword list keeps being used.",
  },
};

export async function inspect(accountId: string, conn: Connection | null, opts: { repair?: boolean; ourDomain?: string } = {}): Promise<Problem[]> {
  await ensureSchema();
  const problems: Problem[] = [];

  // 1. Services every agent relies on.
  const status = await readStatus();
  for (const [part, st] of Object.entries(status) as [Part, NonNullable<(typeof status)[Part]>][]) {
    if (!st || st.ok) continue;
    const p = PART_FIX[part];
    problems.push({
      id: `service:${part}`,
      // Short and plain: what's broken and the one thing to do. The service's own wording stays in the logs.
      text: `${p.name} isn't working${st.lastOk ? ` (last worked ${new Date(st.lastOk).toLocaleDateString()})` : ""}.`,
      fix: p.fix(st.detail ?? ""),
      who: "owner",
      platform: true,
    });
  }

  const [auto, platform] = await Promise.all([readAccountAutopilot(accountId), readPlatformSettings()]);

  // 2. Daily rank checks gone stale: tell the rank tracker to run now.
  if (conn && platform.serperKey && opts.ourDomain) {
    const [row] = await sql`SELECT max(checked_on) AS last FROM insights_rank_daily WHERE account_id = ${accountId}`;
    const last = row?.last ? Date.parse(String(row.last)) : null;
    if (last !== null && Date.now() - last > 2 * 24 * HOUR) {
      const checked = opts.repair ? await trackRanks(accountId, conn, platform.serperKey, opts.ourDomain).catch(() => 0) : 0;
      problems.push({
        id: "ranks:stale",
        text: `Rankings hadn't been checked since ${new Date(last).toLocaleDateString()}.`,
        fix: checked ? `The rank tracker was told to run again and checked ${checked} searches.` : "The rank tracker will be asked to run again on the next hourly check.",
        who: checked ? "repaired" : "watching",
      });
    }
  }

  // 3. The autopilot itself: switched on but not running, or running without doing anything.
  if (auto.enabled && !isSabbath()) {
    const [acct] = await sql`SELECT last_run_at FROM insights_account_autopilot WHERE account_id = ${accountId}`;
    const lastRun = acct?.last_run_at ? Date.parse(String(acct.last_run_at)) : null;
    // A run waits out the Sabbath, so allow for that day as well as the usual one.
    if (lastRun && Date.now() - lastRun > 50 * HOUR) {
      problems.push({
        id: "autopilot:stalled",
        text: `The autopilot hasn't run in ${Math.round((Date.now() - lastRun) / HOUR)} hours.`,
        fix: "It is queued for the next hourly check. If this stays, the website or store connection likely needs reconnecting in Settings.",
        who: "watching",
      });
    }
    const runs = await sql`
      SELECT r.summary, r.status, (SELECT count(*) FROM insights_autopilot_changes c WHERE c.run_id = r.id AND c.status IN ('applied','suggested','kept')) AS made
      FROM insights_autopilot_runs r WHERE r.account_id = ${accountId} AND r.finished_at IS NOT NULL
      ORDER BY r.started_at DESC LIMIT 4`;
    if (runs.length >= 4 && runs.every((r) => Number(r.made) === 0)) {
      const why = runs[0]?.summary ?? "";
      problems.push({
        id: "autopilot:idle",
        text: "The last 4 autopilot runs changed nothing.",
        fix: /weekly limit/i.test(why)
          ? "It keeps hitting the weekly page limit. Raise pages per week under Content if you want it to do more."
          : /no new opportunities|nothing urgent/i.test(why)
            ? "It ran out of pages to improve. Click Rank for this on a few Easy searches under Keywords to give it new targets."
            : `Last run said: ${why.slice(0, 200) || "no reason given"}.`,
        who: "owner",
      });
    }
    const failed = runs.find((r) => /fail|error/i.test(String(r.status)));
    if (failed && runs[0] === failed) {
      problems.push({ id: "autopilot:failed", text: "The last autopilot run failed.", fix: String(failed.summary ?? "The next run will try again.").slice(0, 300), who: "watching" });
    }
  }

  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`inspect:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), problems })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
  return problems;
}
