import { ensureSchema, sql } from "../db";
import type { Problem } from "./inspector";
import { readScorecard } from "./scorecard";
import { readAccountAutopilot, readPlatformSettings } from "./settings";
import { report } from "./status";
import { readStrategy } from "./strategist";

/**
 * Emails to the site owner: urgent problems only a person can fix, as soon as the Inspector finds them (each one
 * at most every three days), and a short weekly report. Sent through Resend once the platform owner adds its key.
 * Off when the owner turns emails off. Never on the Sabbath (the hourly check doesn't run then).
 */
const REPEAT_DAYS = 3;

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

/** Urgent: what needs the owner, said once (again after three days if it's still there). */
export async function sendUrgentAlerts(accountId: string, problems: Problem[]): Promise<number> {
  await ensureSchema();
  const acct = await readAccountAutopilot(accountId);
  if (!acct.emailAlerts) return 0;
  const urgent = problems.filter((p) => p.who === "owner" && !p.platform);
  if (!urgent.length) return 0;
  const key = `alerts_sent:${accountId}`;
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key}`;
  const sent = (row?.value ? JSON.parse(row.value) : {}) as Record<string, string>;
  const fresh = urgent.filter((p) => !sent[p.id] || Date.now() - Date.parse(sent[p.id]) > REPEAT_DAYS * 864e5);
  if (!fresh.length) return 0;
  const to = await ownerEmail(accountId);
  if (!to) return 0;
  const text = [
    "Hello,",
    "",
    `DashPatrol found ${fresh.length === 1 ? "something that needs you" : `${fresh.length} things that need you`}:`,
    "",
    ...fresh.map((p) => `${p.text}\n${p.fix}\n`),
    "Everything else keeps running. You can turn these emails off in Autopilot settings.",
  ].join("\n");
  if (!(await sendEmail(to, fresh.length === 1 ? `Needs your attention: ${fresh[0].text.slice(0, 60)}` : "DashPatrol needs your attention", text))) return 0;
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
    SELECT count(*) FILTER (WHERE field NOT IN ('new_article', 'prune', 'link_fix', 'internal_link')) AS changes,
      count(*) FILTER (WHERE field = 'new_article') AS articles, count(*) FILTER (WHERE field = 'internal_link') AS links
    FROM insights_autopilot_changes WHERE account_id = ${accountId} AND status IN ('applied', 'kept') AND created_at > now() - interval '7 days'`;
  const lines = ["Hello,", "", "Here is your DashPatrol week."];
  if (strategy?.visitors != null) lines.push("", `Visitors from Google, last 28 days: ${strategy.visitors} (goal ${strategy.goal} a month).`);
  lines.push(`This week: ${week.changes} page changes, ${week.articles} new articles, ${week.links} links between your pages.`);
  if (strategy?.assessment) lines.push("", `Where things stand: ${strategy.assessment}`);
  const kept = strategy?.moves.filter((m) => m.kept) ?? [];
  if (kept.length) lines.push("", "This week's plan:", ...kept.map((m, i) => `${i + 1}. ${m.action}`));
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

