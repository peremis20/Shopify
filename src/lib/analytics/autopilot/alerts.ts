import { ensureSchema, sql } from "../db";
import type { Problem } from "./inspector";
import { readScorecard } from "./scorecard";
import { readAccountAutopilot, readPlatformSettings } from "./settings";
import { readStatus, report } from "./status";
import { readStrategy } from "./strategist";
import { trimWords } from "./guards";
import { polish } from "./writer";
import { readProspects } from "./backlinks";
import { weekResults, type ChannelResult, type WeekResults } from "./signals";
import { getConnection } from "../connection";
import { salesFor } from "./shopify-sales";

/**
 * Emails to the site owner: urgent problems only a person can fix, as soon as the Inspector finds them (each once
 * per occurrence), and a short weekly report. Sent through Resend once the platform owner adds its key.
 * Off when the owner turns emails off. Never on the Sabbath (the hourly check doesn't run then).
 */

async function ownerEmail(accountId: string): Promise<string | null> {
  const [row] = await sql`SELECT email FROM insights_accounts WHERE id = ${accountId}`;
  return row?.email ?? null;
}

/** Why the last email didn't go out, in Resend's words (shown when the owner saves the keys). */
export let lastEmailError: string | null = null;

export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const p = await readPlatformSettings();
  lastEmailError = null;
  if (!p.resendKey || !p.alertsFrom) {
    // Not quiet: the Inspector shows the owner that emails can't go out until this is set up.
    lastEmailError = `Emails are not set up: add ${!p.resendKey ? "a Resend key" : ""}${!p.resendKey && !p.alertsFrom ? " and " : ""}${!p.alertsFrom ? "a from address" : ""} in Platform keys.`;
    await report("email", false, lastEmailError);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${p.resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: p.alertsFrom, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => (console.error(`email not sent: ${(e as Error).message}`), null));
  if (!res?.ok) {
    const why = res ? `${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` : "no answer";
    lastEmailError = `Resend didn't send the email (${why}).`;
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
  // For each problem told: when it was sent, and how many complete checks in a row haven't found it.
  const raw = (row?.value ? JSON.parse(row.value) : {}) as Record<string, { sent: string; missed?: number } | string>;
  const sent: Record<string, { sent: string; missed: number }> = {};
  for (const [id, v] of Object.entries(raw)) sent[id] = typeof v === "string" ? { sent: v, missed: 0 } : { sent: v.sent, missed: v.missed ?? 0 };
  const now = new Date().toISOString();
  // Called only with a complete check: an id it found is still open; one it didn't find is a miss. Forgotten after
  // two misses in a row, however far apart the checks are, so a lasting problem is never sent twice.
  const open = new Set(problems.map((p) => p.id));
  for (const [id, v] of Object.entries(sent)) {
    v.missed = open.has(id) ? 0 : v.missed + 1;
    if (v.missed >= 2) delete sent[id];
  }
  // Any problem worth an inbox that the agents haven't already repaired.
  const urgent = problems.filter((p) => p.who !== "repaired" && !p.platform && EMAIL_WORTHY.test(p.id));
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
  for (const p of fresh) sent[p.id] = { sent: now, missed: 0 };
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key}, ${JSON.stringify(sent)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return fresh.length;
}

const plural = (n: unknown, word: string) => `${Number(n)} ${word}${Number(n) === 1 ? "" : "s"}`;

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
    `This week: ${plural(week.changes, "page change")} made, ${plural(week.articles, "new article")}, ${plural(week.links, "link")} between your pages` +
      (Number(week.suggested) ? `, ${plural(week.suggested, "change")} on your fix list` : "") +
      "."
  );
  // From the Strategist's latest plan, dated, and only when it's recent; only moves a second AI checked.
  const fresh = strategy && Date.now() - Date.parse(strategy.at) < 8 * 864e5 ? strategy : null;
  if (fresh) {
    const made = new Date(fresh.at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    if (fresh.visitors != null) lines.push(`Visitors from Google, the 28 days before ${made}: ${fresh.visitors} (goal ${Number(fresh.goal).toLocaleString("en-US")} a month).`);
    if (fresh.assessment) lines.push("", `Where things stood on ${made}: ${polish(fresh.assessment)}`);
    const kept = fresh.checked === false ? [] : fresh.moves.filter((m) => m.kept);
    if (kept.length) lines.push("", `The plan made on ${made}:`, ...kept.map((m, i) => `${i + 1}. ${planLine(m)}`));
  }
  // Read once for both sections: the site's own Google Analytics, never another site's.
  const conn = await getConnection(accountId).catch(() => null);
  const results = conn?.gaPropertyId ? await weekResults(conn).catch((e) => (console.error(`weekly results failed: ${(e as Error).message}`), undefined)) : null;
  lines.push(...resultsLines(results));
  lines.push(...(await backlinkLines(accountId, results ?? null)));
  if (scores.length) lines.push("", "What each agent did:", ...scores.map((s) => `${s.agent}: ${s.did}.${s.result ? ` ${s.result}` : ""}`));
  lines.push("", "You can turn these emails off in Autopilot settings.");
  return lines.join("\n");
}

const WEEK_MS = 7 * 864e5;
const money = (n: number) => Math.round(n).toLocaleString("en-US");
const change = (now: number, before: number) =>
  before > 0 ? ` (${now >= before ? "up" : "down"} ${Math.abs(Math.round(((now - before) / before) * 100))}% from the week before)` : before === 0 && now > 0 ? " (none the week before)" : "";
const resultText = (r: ChannelResult) =>
  `${r.sessions} visits, ${r.keyEvents} key events (leads, sign ups or sales)` + (r.purchases > 0 ? `, of them ${r.purchases} purchases` : "") + (r.revenue > 0 ? `, ${money(r.revenue)} in sales` : "");

/**
 * Visitors, leads and sales by channel from the site's own Google Analytics, compared with the week before.
 * Leads and sales are the key events the site set up in Analytics; nothing is estimated.
 */
/** `r` is null without Google Analytics connected, undefined when it couldn't be read. */
function resultsLines(r: WeekResults | null | undefined): string[] {
  if (r === null) return ["", "Visits, leads and sales: connect Google Analytics in Settings to see them here."];
  if (!r) return ["", "Visits, leads and sales: Google Analytics couldn't be read this week, so they are left out rather than guessed."];
  const shown = r.channels.filter((c) => c.now.sessions > 0 || c.before.sessions > 0).slice(0, 5);
  if (!shown.length) return ["", "Visits, leads and sales, last 7 days: no visits recorded in Google Analytics."];
  const total = r.channels.reduce((n, c) => n + c.now.keyEvents, 0);
  return [
    "",
    "Visits, leads and sales, last 7 days (Google Analytics):",
    ...shown.map((c) => `${c.name.replace(/\s*[-–—]\s*/g, " ")}: ${resultText(c.now)}${change(c.now.sessions, c.before.sessions)}.`),
    ...(total === 0 ? ["No leads or sales were recorded. If your site takes sign ups or orders, mark them as key events in Google Analytics so they count here."] : []),
    "A rise after a change is a good sign, not proof the change caused it.",
  ];
}

/** Backlink outreach this week: emails ready, sent, links won, and what the linking sites sent. */
async function backlinkLines(accountId: string, r: WeekResults | null): Promise<string[]> {
  const list = await readProspects(accountId).catch(() => null);
  if (!list?.prospects.length) return [];
  const recent = (at?: string) => Boolean(at && Date.now() - Date.parse(at) < WEEK_MS);
  const ready = list.prospects.filter((p) => p.status === "new" && p.draft).length;
  const emailed = list.prospects.filter((p) => p.status === "contacted" && recent(p.statusAt)).length;
  const wonAll = list.prospects.filter((p) => p.status === "won");
  const wonWeek = wonAll.filter((p) => recent(p.statusAt)).length;
  const lines = [
    "",
    `Backlinks: ${ready} ${ready === 1 ? "email" : "emails"} ready for you to send, ${emailed} sent this week, ${wonWeek} ${wonWeek === 1 ? "link" : "links"} won this week (${wonAll.length} in total).`,
  ];
  if (wonAll.length) {
    if (r) {
      const from = wonAll
        .map((p) => {
          const d = p.domain.toLowerCase().replace(/^www\./, "");
          let sum: ChannelResult = { sessions: 0, keyEvents: 0, purchases: 0, revenue: 0 };
          for (const [src, v] of r.sources)
            if (src === d || src.endsWith(`.${d}`)) sum = { sessions: sum.sessions + v.sessions, keyEvents: sum.keyEvents + v.keyEvents, purchases: sum.purchases + v.purchases, revenue: sum.revenue + v.revenue };
          return { d, sum };
        })
        .filter((x) => x.sum.sessions > 0);
      lines.push(from.length ? `Visits from sites that link to you: ${from.map((x) => `${x.d} (${resultText(x.sum)})`).join("; ")}.` : "No visits from the sites that link to you yet this week.");
    }
  }
  return lines;
}

export interface WeeklyReportData {
  week: { changes: number; articles: number; links: number; suggested: number };
  /** From the Strategist's latest plan (within 8 days). */
  visitors: { value: number; goal: number; at: string } | null;
  focus: string | null;
  plan: string[];
  /** Why the plan is empty when one was written, in plain words. */
  planNote?: string | null;
  /** "none": Google Analytics isn't connected; "error": it couldn't be read (left out, never guessed). */
  traffic: "none" | "error" | { name: string; now: ChannelResult; before: ChannelResult }[];
  /** Every channel added up (the chart shows the top six). */
  totals: { visits: number; leads: number; revenue: number } | null;
  backlinks: { found: number; ready: number; emailed: number; wonWeek: number; wonAll: number; fromLinks: { domain: string; visits: number; keyEvents: number }[] } | "error" | null;
  agents: { agent: string; did: string; result: string | null }[];
  /** Sales straight from Shopify (last 28 days), or "access" when the app may not read orders yet. */
  shopify: { days?: number; orders: number; revenue: number; currency: string | null; fromGoogle: number; fromGoogleRevenue: number; capped?: boolean; pages: { path: string; orders: number }[] } | "access" | "error" | null;
}

/** One plan step as the owner reads it (page and email alike): it names the search or page it works on. */
function planLine(m: { action: string; keyword: string | null; page?: string | null }): string {
  const text = polish(m.action);
  const named = m.keyword ?? (m.page ? (() => { try { return new URL(m.page).pathname; } catch { return m.page; } })() : null);
  if (!named || text.toLowerCase().includes(named.toLowerCase())) return text;
  return `${text} (${m.keyword ? `for "${named}"` : `on ${named}`})`;
}

/** The same report as the weekly email, as numbers for the Report page's charts. Only this site's data. */
export async function weeklyReportData(accountId: string): Promise<WeeklyReportData> {
  const [strategy, scores, conn, list] = await Promise.all([
    readStrategy(accountId).catch(() => null),
    readScorecard(accountId).catch(() => []),
    getConnection(accountId).catch(() => null),
    readProspects(accountId).catch(() => "error" as const),
  ]);
  const [week] = await sql`
    SELECT count(*) FILTER (WHERE status IN ('applied', 'kept') AND field NOT IN ('new_article', 'prune', 'link_fix', 'internal_link')) AS changes,
      count(*) FILTER (WHERE status = 'suggested') AS suggested,
      count(*) FILTER (WHERE status IN ('applied', 'kept') AND field = 'new_article') AS articles,
      count(*) FILTER (WHERE status IN ('applied', 'kept') AND field = 'internal_link') AS links
    FROM insights_autopilot_changes WHERE account_id = ${accountId} AND created_at > now() - interval '7 days'`;
  const fresh = strategy && Date.now() - Date.parse(strategy.at) < 8 * 864e5 ? strategy : null;
  const results = conn?.gaPropertyId ? await weekResults(conn).catch((e) => (console.error(`weekly results failed: ${(e as Error).message}`), undefined)) : null;
  const recent = (at?: string) => Boolean(at && Date.now() - Date.parse(at) < WEEK_MS);
  const prospects = list === "error" ? null : list;
  const won = (prospects?.prospects ?? []).filter((p) => p.status === "won");
  const fromLinks = results
    ? won
        .map((p) => {
          const d = p.domain.toLowerCase().replace(/^www\./, "");
          let visits = 0;
          let keyEvents = 0;
          for (const [src, v] of results.sources) if (src === d || src.endsWith(`.${d}`)) ((visits += v.sessions), (keyEvents += v.keyEvents));
          return { domain: d, visits, keyEvents };
        })
        .filter((x) => x.visits > 0)
    : [];
  return {
    week: { changes: Number(week.changes), articles: Number(week.articles), links: Number(week.links), suggested: Number(week.suggested) },
    visitors: fresh && fresh.visitors != null ? { value: Number(fresh.visitors), goal: Number(fresh.goal), at: fresh.at } : null,
    // One sentence only, the biggest opportunity when the Strategist named one: the page shows numbers, not paragraphs.
    focus: fresh?.assessment ? polish(((ss) => ss.find((x) => /opportunit/i.test(x)) ?? ss[0])(fresh.assessment.split(/(?<=\.)\s+/))) : null,
    plan: fresh && fresh.checked !== false ? fresh.moves.filter((m) => m.kept).map(planLine) : [],
    planNote: fresh && fresh.checked === false
      ? "This week's plan is written but still waiting for its second AI check, so it shows here once confirmed."
      : fresh && !fresh.moves.some((m) => m.kept)
        ? "The second AI check found no move this week backed by the data, so none are planned."
        : null,
    traffic: results === null ? "none" : !results ? "error" : results.channels.filter((c) => c.now.sessions > 0 || c.before.sessions > 0).slice(0, 6).map((c) => ({ ...c, name: c.name.replace(/\s*[-–—]\s*/g, " ") })),
    totals: results
      ? results.channels.reduce((t, c) => ({ visits: t.visits + c.now.sessions, leads: t.leads + c.now.keyEvents, revenue: t.revenue + c.now.revenue }), { visits: 0, leads: 0, revenue: 0 })
      : null,
    backlinks: list === "error" ? "error" : prospects?.prospects.length
      ? {
          found: prospects.prospects.length,
          ready: prospects.prospects.filter((p) => p.status === "new" && p.draft).length,
          emailed: prospects.prospects.filter((p) => p.status === "contacted" || p.status === "won").length,
          wonWeek: won.filter((p) => recent(p.statusAt)).length,
          wonAll: won.length,
          fromLinks,
        }
      : null,
    agents: scores.map((x) => ({ agent: x.agent, did: x.did, result: x.result })),
    // A failed read is "error", never mistaken for "no store".
    shopify: await salesFor(accountId).catch((e) => (console.error(`weekly shopify sales failed: ${(e as Error).message}`), "error" as const)),
  };
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

/**
 * Each hour: when emails show as not working and a key or a from address is saved, a test goes to the platform
 * owner, so a fix clears by itself without saving again. At most once an hour, and only while it keeps failing.
 */
export async function retestEmail(): Promise<void> {
  const st = (await readStatus()).email;
  if (st?.ok !== false || (st.at && Date.now() - Date.parse(st.at) < 50 * 60_000)) return;
  const p = await readPlatformSettings();
  const to = (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).find(Boolean);
  if (!to || (!p.resendKey && !p.alertsFrom)) return;
  // One try per window, even with several tabs open at once: whoever claims the slot sends.
  const [claimed] = await sql`
    INSERT INTO insights_settings (key, value) VALUES ('email_retest', ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE insights_settings.updated_at < now() - interval '50 minutes'
    RETURNING key`;
  if (!claimed) return;
  // With one of the two missing, sendEmail records which one, so the warning names exactly what to add.
  await sendEmail(to, "DashPatrol emails are working", "This is a test from DashPatrol. Weekly reports and urgent alerts will reach this inbox.");
}
