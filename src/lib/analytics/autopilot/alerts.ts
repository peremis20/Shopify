import { ensureSchema, sql } from "../db";
import type { Problem } from "./inspector";
import { readScorecard } from "./scorecard";
import { readAccountAutopilot, readPlatformSettings } from "./settings";
import { report } from "./status";
import { readStrategy } from "./strategist";
import { trimWords } from "./guards";
import { polish } from "./writer";

/**
 * Emails to the site owner: urgent problems only a person can fix, as soon as the Inspector finds them (each once
 * per occurrence), and a short weekly report. Sent through Resend once the platform owner adds its key.
 * Off when the owner turns emails off. Never on the Sabbath (the hourly check doesn't run then).
 */

async function ownerEmail(accountId: string): Promise<string | null> {
  const [row] = await sql`SELECT email FROM insights_accounts WHERE id = ${accountId}`;
  return row?.email ?? null;
}

export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const p = await readPlatformSettings();
  if (!p.resendKey || !p.alertsFrom) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${p.resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: p.alertsFrom, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => (console.error(`email not sent: ${(e as Error).message}`), null));
  if (!res?.ok) {
    const why = res ? `${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` : "no answer";
    await report("email", false, why);
    return false;
  }
  await report("email", true);
  return true;
}

/** Problems worth an email: the site is losing traffic or the agents are stuck. Not nags the dashboard covers. */
export const EMAIL_WORTHY = /^(traffic:drop|autopilot:failed|autopilot:stalled|ranks:stale)$/;

/**
 * Urgent: an email-worthy problem only the owner can fix, sent once when it appears. It is sent again only if it
 * clears and later comes back, so a lasting problem never repeats in the inbox.
 */
export async function sendUrgentAlerts(accountId: string, problems: Problem[]): Promise<number> {
  await ensureSchema();
  const acct = await readAccountAutopilot(accountId);
  if (!acct.emailAlerts) return 0;
  const key = `alerts_sent:${accountId}`;
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key}`;
  const sent = (row?.value ? JSON.parse(row.value) : {}) as Record<string, string>;
  // A problem that has cleared is forgotten, so it can be told again if it ever returns.
  const open = new Set(problems.map((p) => p.id));
  for (const id of Object.keys(sent)) if (!open.has(id)) delete sent[id];
  const urgent = problems.filter((p) => p.who === "owner" && !p.platform && EMAIL_WORTHY.test(p.id));
  const fresh = urgent.filter((p) => !sent[p.id]);
  if (!fresh.length) {
    await sql`
      INSERT INTO insights_settings (key, value) VALUES (${key}, ${JSON.stringify(sent)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    return 0;
  }
  const to = await ownerEmail(accountId);
  if (!to) return 0;
  const text = [
    "Hello,",
    "",
    `DashPatrol found ${fresh.length === 1 ? "something that needs you" : `${fresh.length} things that need you`}:`,
    "",
    ...fresh.map((p) => `${p.text}\n${p.fix}\n`),
    "Open DashPatrol to see the details. Everything else keeps running.",
    "You can turn these emails off in Autopilot settings.",
  ].join("\n");
  if (!(await sendEmail(to, fresh.length === 1 ? `Needs your attention: ${trimWords(fresh[0].text, 60)}` : "DashPatrol needs your attention", text))) return 0;
  for (const p of fresh) sent[p.id] = new Date().toISOString();
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key}, ${JSON.stringify(sent)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return fresh.length;
}

/** The weekly report: this site's numbers and each agent's record, plain and short. */
export async function weeklyReportText(accountId: string): Promise<string> {
  const strategy = await readStrategy(accountId).catch(() => null);
  const scores = await readScorecard(accountId).catch(() => []);
  const [week] = await sql`
    SELECT count(*) FILTER (WHERE status IN ('applied', 'kept') AND field NOT IN ('new_article', 'prune', 'link_fix', 'internal_link')) AS changes,
      count(*) FILTER (WHERE status = 'suggested') AS suggested,
      count(*) FILTER (WHERE status IN ('applied', 'kept') AND field = 'new_article') AS articles,
      count(*) FILTER (WHERE status IN ('applied', 'kept') AND field = 'internal_link') AS links
    FROM insights_autopilot_changes WHERE account_id = ${accountId} AND created_at > now() - interval '7 days'`;
  const lines = ["Hello,", "", "Here is your DashPatrol week."];
  lines.push(
    "",
    `This week: ${week.changes} page changes made, ${week.articles} new articles, ${week.links} links between your pages` +
      (Number(week.suggested) ? `, ${week.suggested} changes on your fix list` : "") +
      "."
  );
  // From the Strategist's latest plan, dated, and only when it's recent; only moves a second AI checked.
  const fresh = strategy && Date.now() - Date.parse(strategy.at) < 8 * 864e5 ? strategy : null;
  if (fresh) {
    const made = new Date(fresh.at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    if (fresh.visitors != null) lines.push(`Visitors from Google, the 28 days before ${made}: ${fresh.visitors} (goal ${fresh.goal} a month).`);
    if (fresh.assessment) lines.push("", `Where things stood on ${made}: ${polish(fresh.assessment)}`);
    const kept = fresh.checked === false ? [] : fresh.moves.filter((m) => m.kept);
    if (kept.length) lines.push("", `The plan made on ${made}:`, ...kept.map((m, i) => `${i + 1}. ${polish(m.action)}`));
  }
  if (scores.length) lines.push("", "What each agent did:", ...scores.map((s) => `${s.agent}: ${s.did}.${s.result ? ` ${s.result}` : ""}`));
  lines.push("", "You can turn these emails off in Autopilot settings.");
  return lines.join("\n");
}

/** Sites with emails on whose weekly report is due. */
export async function accountsDueForWeeklyReport(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'weekly_report:' || a.account_id
    WHERE a.enabled AND coalesce(a.email_alerts, true) AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export async function sendWeeklyReport(accountId: string): Promise<boolean> {
  const to = await ownerEmail(accountId);
  // Marked either way, so a site without email (or an email outage) waits a week instead of retrying every hour.
  const ok = to ? await sendEmail(to, "Your DashPatrol week", await weeklyReportText(accountId)) : false;
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`weekly_report:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), sent: ok })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return ok;
}

