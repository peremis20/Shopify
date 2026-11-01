import { readProspects } from "./backlinks";
import { clientListKnown, otherClient } from "./clients";
import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { readAccountAutopilot, readPlatformSettings } from "./settings";
import { readStatus, type Part } from "./status";
import { trackRanks } from "./tracking";
import { isSabbath } from "./sabbath";
import { hasScope } from "../google-auth";
import { rankingTurbulence } from "./google-updates";
import { trafficCheck } from "./guards";
import { usageThisMonth } from "./usage";

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
  email: {
    name: "Owner emails (resend.com)",
    fix: (d) => (/domain|verify|403/i.test(d) ? "Verify the sending domain in Resend, or change the email sender in Platform keys." : "Check the email key in Platform keys."),
    workaround: "Reports and alerts still show on the dashboard.",
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
      FROM insights_autopilot_runs r WHERE r.account_id = ${accountId} AND r.finished_at IS NOT NULL AND r.trigger <> 'preview'
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

  // 4. Rankings swinging for reasons that aren't the agents' work: changes wait to be judged, the owner is told why.
  const turbulence = await rankingTurbulence().catch(() => null);
  if (turbulence) problems.push({ id: "google:update", text: turbulence, fix: "Nothing to do: the agents keep working, and the untouched control pages show what the changes did.", who: "watching" });
  const traffic = conn?.gscSiteUrl ? await trafficCheck(conn).catch(() => null) : null;
  if (traffic?.sharp) {
    problems.push({
      id: "traffic:drop",
      text: `Google clicks fell ${Math.round(traffic.drop * 100)}% last week (${traffic.recentWeek} against a usual ${traffic.usualWeek}).`,
      fix: "New changes, take downs and verdicts are on hold. Check Search Console for a site problem; the agents resume once clicks recover.",
      who: "owner",
    });
  }

  // Spending: warn at 80% of the month's limit, and say plainly what pauses at 100%.
  const used = await usageThisMonth(accountId).catch(() => null);
  if (used) {
    for (const kind of ["ai", "search"] as const) {
      const share = used[kind] / used.limits[kind];
      const name = kind === "ai" ? "AI" : "Google results";
      if (share >= 1) problems.push({ id: `limit:${kind}`, text: `This site used its ${name} limit for the month (${used.limits[kind]}).`, fix: "What needs it pauses until next month, or the platform owner raises the limit.", who: "owner", platform: true });
      else if (share >= 0.8) problems.push({ id: `limit:${kind}`, text: `This site has used ${Math.round(share * 100)}% of its ${name} limit for the month.`, fix: "Work carries on; at the limit, what needs it pauses until next month.", who: "watching" });
    }
  }

  // 5. Google may be asked to recrawl changed pages only with permission to manage Search Console.
  if (conn?.gscSiteUrl) {
    const allowed = await hasScope({ kind: "oauth", refreshToken: conn.refreshToken }, "https://www.googleapis.com/auth/webmasters").catch(() => null);
    if (allowed === false) {
      problems.push({
        id: "google:recrawl",
        text: "The app can't ask Google to look at your changed pages sooner.",
        fix: "Click Allow and accept on Google's screen, so each change reaches Google faster.",
        who: "owner",
      });
    }
  }

  // 6. Each site's data stays its own: no other customer in its backlink list, no site's own ranking in the shared caches.
  if (opts.ourDomain && (await clientListKnown())) {
    const isOther = await otherClient(opts.ourDomain);
    const list = await readProspects(accountId).catch(() => null);
    const crossed = (list?.prospects ?? []).filter((p) => isOther(p.domain));
    const [leak] = await sql`SELECT count(*) AS n FROM insights_report_cache WHERE cache_key LIKE 'kd:%' AND data->>'ours' IS NOT NULL`;
    const leaks = Number(leak?.n ?? 0);
    if (crossed.length || leaks) {
      if (opts.repair) {
        if (crossed.length && list) {
          await sql`UPDATE insights_settings SET value = ${JSON.stringify({ ...list, prospects: list.prospects.filter((p) => !isOther(p.domain)) })}
            WHERE key = ${`backlinks:${accountId}`}`.catch(() => undefined);
        }
        if (leaks) await sql`UPDATE insights_report_cache SET data = jsonb_set(data, '{ours}', 'null'::jsonb) WHERE cache_key LIKE 'kd:%' AND data->>'ours' IS NOT NULL`.catch(() => undefined);
      }
      problems.push({
        id: "data:isolation",
        text: `Found data that belongs to another site (${[crossed.length && `${crossed.length} customer sites in the backlink list`, leaks && `${leaks} saved rankings in a shared cache`].filter(Boolean).join(", ")}).`,
        fix: opts.repair ? "Removed it, so this site only uses its own data." : "It will be removed on the next hourly check.",
        who: opts.repair ? "repaired" : "watching",
      });
    }
  }

  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`inspect:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), problems })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
  return problems;
}
