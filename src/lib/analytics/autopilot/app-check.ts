import { createHash } from "node:crypto";
import { ensureSchema, sql } from "../db";
import type { Connection } from "../connection";
import { readProfile } from "../profile";
import { weeklyReportData, type WeeklyReportData } from "./alerts";
import type { Problem } from "./inspector";
import { readAccountAutopilot, readPlatformSettings, aiProvider } from "./settings";
import { readStrategy } from "./strategist";
import { asPlatform } from "./usage";
import { reviewCustomerView } from "./writer";

/**
 * The App checker: part of the Inspector that looks past each agent's own job. It opens a site's account the way the
 * owner sees it and asks: does anything look broken, empty, contradictory, confusing or worse than on other sites?
 * The other agents check that their own work ran; this one checks what the customer ends up looking at.
 *
 * 1. Rules, every 6 hours: each section loads, loads fast, shows no "NaN"/"undefined"/dashes, agrees with what is
 *    connected, and isn't empty while it is filled on most other sites of the same age.
 * 2. Once a day, a second AI reads the whole view as a demanding first time customer and lists anything that looks
 *    wrong, and the first AI confirms each point against the data before it counts (nothing guessed is reported).
 *
 * Other sites are compared by shape only (which sections have content), never by their data.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = (id: string) => `app_check:${id}`;

/** Which parts of the app have something to show for this site. Shape only, shared between sites for comparison. */
export type Shape = Record<Section, boolean>;
type Section = "visits" | "plan" | "agents" | "backlinks" | "keywords" | "pages" | "ranks" | "business" | "changes";
const SECTION_NAME: Record<Section, string> = {
  visits: "Report: where visits came from",
  plan: "Report: this week's plan",
  agents: "Report: what each agent did",
  backlinks: "Backlinks list",
  keywords: "Keywords list",
  pages: "Site pages read",
  ranks: "Daily rank checks",
  business: "Business profile",
  changes: "Changes made by the autopilot",
};
/** Days after connecting by which a working site has each section filled. */
const READY_DAYS: Record<Section, number> = { visits: 7, plan: 8, agents: 7, backlinks: 5, keywords: 3, pages: 3, ranks: 4, business: 3, changes: 7 };

interface Saved {
  at: string;
  aiAt: string | null;
  shape: Shape;
  age: number;
  problems: Problem[];
  aiProblems: Problem[];
}

async function readSaved(accountId: string): Promise<Saved | null> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`.catch(() => [] as { value: string | null }[]);
  try {
    return row?.value ? (JSON.parse(row.value) as Saved) : null;
  } catch {
    return null;
  }
}

/** Every string a customer would read, with where it came from. Addresses and paths are skipped. */
export function visibleText(value: unknown, path = ""): { path: string; text: string }[] {
  if (typeof value === "string") return /^(https?:\/\/|\/)\S*$/.test(value) || /^\d{4}-\d\d-\d\dT/.test(value) ? [] : [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => visibleText(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => (/^(at|url|path|domain|currency)$/.test(k) ? [] : visibleText(v, path ? `${path}.${k}` : k)));
  return [];
}

/** Text a customer should never see: leaked code values, or dashes (the app's writing rule). */
export function badText(text: string): string | null {
  if (/\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b/.test(text)) return "a broken value";
  if (/^null$/.test(text.trim())) return "a broken value";
  if (/\s[-–—]\s|[–—]/.test(text)) return "a dash";
  return null;
}

/** What the rules find; pure so it can be tested. */
export function ruleProblems(input: {
  report: WeeklyReportData | null;
  reportError: string | null;
  reportMs: number;
  conn: { ga: boolean; gsc: boolean };
  shape: Shape;
  age: number;
  peers: { shape: Shape; age: number }[];
}): Problem[] {
  const out: Problem[] = [];
  const add = (id: string, text: string, fix: string) => out.push({ id: `app:${id}`, text, fix, who: "watching", platform: true });
  if (input.reportError) add("report-fails", `The Report page can't load for this site: ${input.reportError.slice(0, 200)}`, "The platform owner is told, so the cause gets fixed.");
  else if (input.reportMs > 15_000) add("report-slow", `The Report page took ${Math.round(input.reportMs / 1000)} seconds to build for this site.`, "The platform owner is told, so it can be made faster.");
  const r = input.report;
  if (r) {
    if (input.conn.ga && r.traffic === "error") add("ga-unread", "Google Analytics is connected, but the Report couldn't read it.", "The platform owner is told. If it stays, reconnect Google in Settings.");
    if (r.shopify === "error") add("shop-unread", "The store is connected, but its orders couldn't be read for the Report.", "The platform owner is told. If it stays, reconnect the store under Content.");
    if (r.backlinks === "error") add("backlinks-unread", "The backlinks list couldn't be read for the Report.", "The platform owner is told, so the cause gets fixed.");
    const bad = visibleText(r)
      .map((t) => ({ ...t, why: badText(t.text) }))
      .filter((t) => t.why);
    if (bad.length) add("bad-text", `The Report shows ${bad[0].why} in "${bad[0].text.slice(0, 120)}"${bad.length > 1 ? ` and ${bad.length - 1} more places` : ""}.`, "The platform owner is told, so the wording gets fixed.");
  }
  // Empty well past when it should be filled, while most sites of that age have it: a gap a customer would notice.
  const grown = input.peers.filter((p) => p.age >= 7);
  for (const s of Object.keys(READY_DAYS) as Section[]) {
    if (input.shape[s] || input.age < READY_DAYS[s]) continue;
    const others = grown.filter((p) => p.age >= READY_DAYS[s]);
    const filled = others.filter((p) => p.shape[s]).length;
    // Empty on most sites too means it depends on the site (a new store, no traffic yet), not that this one is broken.
    if (others.length && filled / others.length < 0.5) continue;
    if (s === "visits" && !input.conn.ga) continue;
    add(`empty:${s}`, `${SECTION_NAME[s]} is still empty ${Math.floor(input.age)} days after this site connected${others.length ? `, while ${filled} of ${others.length} other sites have it` : ""}.`, "The platform owner is told, so the agent that fills it gets looked at.");
  }
  return out;
}

async function shapeOf(accountId: string, report: WeeklyReportData | null): Promise<Shape> {
  const [counts] = await sql`
    SELECT
      (SELECT count(*) FROM insights_tracked_keywords t JOIN insights_keyword_lists l ON l.id = t.list_id WHERE l.account_id = ${accountId}) AS keywords,
      (SELECT count(*) FROM insights_site_pages WHERE account_id = ${accountId}) AS pages,
      (SELECT count(*) FROM insights_rank_daily WHERE account_id = ${accountId} AND checked_on > now() - interval '4 days') AS ranks,
      (SELECT count(*) FROM insights_autopilot_changes WHERE account_id = ${accountId}) AS changes`;
  const profile = await readProfile(accountId).catch(() => null);
  const strategy = await readStrategy(accountId).catch(() => null);
  const traffic = report && Array.isArray(report.traffic) ? report.traffic : [];
  const bl = report && report.backlinks && typeof report.backlinks === "object" ? report.backlinks : null;
  return {
    visits: traffic.length > 0,
    plan: Boolean(strategy && Date.now() - Date.parse(strategy.at) < 8 * DAY && strategy.moves.length),
    agents: Boolean(report?.agents.length),
    backlinks: Boolean(bl?.found),
    keywords: Number(counts?.keywords ?? 0) > 0,
    pages: Number(counts?.pages ?? 0) > 0,
    ranks: Number(counts?.ranks ?? 0) > 0,
    business: Boolean(profile?.about),
    changes: Number(counts?.changes ?? 0) > 0,
  };
}

/** Days since the site connected Google (or the account was made). */
async function ageOf(accountId: string): Promise<number> {
  const [row] = await sql`
    SELECT LEAST(
      COALESCE((SELECT connected_at FROM insights_account_google WHERE account_id = ${accountId}), now()),
      COALESCE((SELECT created_at FROM insights_accounts WHERE id = ${accountId}), now())
    ) AS since`;
  return row?.since ? (Date.now() - Date.parse(String(row.since))) / DAY : 0;
}

/**
 * Runs the App checker for one site when due, and returns what it found (the saved findings between runs).
 * Never throws: a failure of the checker itself is reported as a problem, not swallowed.
 */
export async function appCheck(accountId: string, conn: Connection | null, opts: { force?: boolean } = {}): Promise<Problem[]> {
  await ensureSchema();
  const saved = await readSaved(accountId);
  if (saved && !opts.force && Date.now() - Date.parse(saved.at) < 6 * HOUR) return [...saved.problems, ...saved.aiProblems];
  try {
    const started = Date.now();
    let reportError: string | null = null;
    // Built as the platform's own check: it isn't counted against the site's monthly limits.
    const report = await asPlatform(() => weeklyReportData(accountId)).catch((e) => ((reportError = (e as Error).message), null));
    const reportMs = Date.now() - started;
    const shape = await shapeOf(accountId, report);
    const age = await ageOf(accountId);
    const peerRows = await sql`SELECT key, value FROM insights_settings WHERE key LIKE 'app_check:%' AND key <> ${KEY(accountId)}`.catch(() => [] as { key: string; value: string }[]);
    const peers = peerRows.flatMap((r) => {
      try {
        const v = JSON.parse(String(r.value)) as Saved;
        return v.shape ? [{ shape: v.shape, age: v.age + (Date.now() - Date.parse(v.at)) / DAY }] : [];
      } catch {
        return [];
      }
    });
    const problems = ruleProblems({ report, reportError, reportMs, conn: { ga: Boolean(conn?.gaPropertyId), gsc: Boolean(conn?.gscSiteUrl) }, shape, age, peers });

    // Once a day: a second AI reads the whole view like a customer would, and the first confirms each point.
    let aiProblems = saved?.aiProblems ?? [];
    let aiAt = saved?.aiAt ?? null;
    if (report && (!aiAt || Date.now() - Date.parse(aiAt) > DAY || opts.force)) {
      const ai = aiProvider(await readPlatformSettings());
      if (ai) {
        const [profile, auto, strategy] = await Promise.all([readProfile(accountId).catch(() => null), readAccountAutopilot(accountId).catch(() => null), readStrategy(accountId).catch(() => null)]);
        const view = {
          site: profile?.siteDomain ?? null,
          connected: { googleAnalytics: Boolean(conn?.gaPropertyId), searchConsole: Boolean(conn?.gscSiteUrl), store: Boolean(auto?.shopTokenEnc) },
          daysSinceConnected: Math.floor(age),
          autopilotOn: Boolean(auto?.enabled),
          sectionsWithContent: shape,
          report,
          planMadeAt: strategy?.at ?? null,
          ruleFindings: problems.map((p) => p.text),
        };
        const usual = (Object.keys(READY_DAYS) as Section[]).filter((s) => peers.filter((p) => p.age >= READY_DAYS[s]).some((p) => p.shape[s]));
        // A busy or failed AI keeps yesterday's findings and tries again next pass; its outage shows on the status board.
        const issues = await asPlatform(() => reviewCustomerView(ai, JSON.stringify(view).slice(0, 9000), usual.map((s) => SECTION_NAME[s]))).catch(
          (e) => (console.error(`app check AI review failed: ${(e as Error).message}`), null)
        );
        if (issues) aiProblems = issues.map((i) => ({
          id: `app:ai:${createHash("sha1").update(i.text).digest("hex").slice(0, 10)}`,
          text: `Customer view check: ${i.text}`,
          fix: i.fix || "The platform owner is told, so it gets fixed.",
          who: "watching" as const,
          platform: true,
        }));
        if (issues) aiAt = new Date().toISOString();
      }
    }
    const next: Saved = { at: new Date().toISOString(), aiAt, shape, age, problems, aiProblems };
    await sql`INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(next)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    return [...problems, ...aiProblems];
  } catch (e) {
    return [{ id: "app:checker", text: `The App checker couldn't look at this site: ${(e as Error).message.slice(0, 200)}`, fix: "It tries again next hour by itself.", who: "watching", platform: true }];
  }
}
