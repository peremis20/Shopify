import { readTargets, saveTarget } from "./targets";
import { setArticlePublished } from "./shopify";
import { restoreTarget } from "./pruner";
import { nextNewArticle, unpublishArticle } from "./new-articles";
import { getConnection, type Connection } from "../connection";
import { ensureSchema, sql, type Row } from "../db";
import { resolveRange } from "../dates";
import { googleRequest } from "../google-auth";
import { readProfile, siteBrief } from "../profile";
import { makeNextShareKit } from "./share-kit";
import type { Opportunity } from "../seo-types";
import { readyApps, type Candidate, type Hub, type Mode, type RankingApp } from "./apps";
import { keyOf } from "./apps/types";
import { clickGain } from "./keyword-boost";
import { aiProvider, readAccountAutopilot, readPlatformSettings, type AiProvider, type PlatformSettings } from "./settings";
import {
  copiedFrom,
  duplicateOf,
  pagesForQuery,
  plainText,
  PROTECTED_PAGE,
  strongerRival,
  trafficCheck,
  type SiteItem,
} from "./guards";
import { undoLinkFix } from "./link-fixer";
import { EditedMeanwhile, siteFor, type SiteAccess, type SiteWriter } from "./site-source";
import { buildSchema, liveHtml, withoutAutopilotSchema } from "./schema";
import type { StoreAccess, StoreResource } from "./shopify";
import type { AutopilotChange, AutopilotPreview, AutopilotRun, ChangeField } from "./types";
import { lessons, measuredResults } from "./results";
import { googleUpdates, updatesDuring, type GoogleUpdate } from "./google-updates";
import { expireReviews } from "./expert-review";
import { askGoogleToRecrawl } from "./recrawl";
import { blocksOf, dropBlocks, hasSecondAi, ownerApproves, writeImprovement, writeInternalLink, type PageImprovement } from "./writer";

/**
 * The SEO autopilot. Each run: measure older changes and undo the ones that
 * hurt, then improve one page (titles, descriptions, alt text, a new
 * section, an internal link), within the weekly page limit.
 *
 * Which page, in order:
 * 1. Defend: a page one search that is slipping.
 * 2. Attack: the biggest gain among #2 to #3 searches going for #1, and #4 to #20 going for the top 3.
 * The connected apps (./apps) suggest the candidates, size and weight them,
 * and brief the writer on the chosen one: Search Console, Analytics, Keyword
 * Planner and Google page one today, more as they're added.
 */

const MEASURE_AFTER_DAYS = 28;
const REST_DAYS_PER_PAGE = 45;
/** A slipping page can be defended again sooner, once the last change has had time to count. */
const DEFEND_REST_DAYS = 21;
const WORSE_BY_POSITIONS = 3;

/** Everything a run needs for one customer. */
/** Urgent fixes allowed over the weekly page limit. */
const URGENT_EXTRA = 2;
/** Beyond that, pages Google left out of its index still get fixed: being in Google comes before a steady pace. */
const INDEX_EXTRA = 3;

interface Ctx {
  accountId: string;
  /** Where pages are read from; on a Shopify store also where changes are written. */
  site: SiteAccess;
  /** Shopify only. */
  store: StoreAccess | null;
  ai: AiProvider;
  platform: PlatformSettings;
  ourDomain: string;
  allowContent: boolean;
  maxPagesPerWeek: number;
  /** Over the weekly limit: only urgent work (a search that fell, a page Google left out) may go ahead. */
  urgentOnly?: boolean;
  /** Past the urgent room too: only getting a page Google left out into its index may go ahead. */
  indexOnly?: boolean;
  /** The site's pages, loaded once per run for the duplicate guards. */
  index?: Promise<SiteItem[]>;
  /** A preview run: nothing is changed or recorded. */
  preview?: boolean;
  /** With only one AI service the owner is the second check: changes wait for the owner's approval, nothing goes live before. */
  ownerApproves?: boolean;
  /** Paths of pages held as controls: no agent adds links to them. */
  controlPaths?: Set<string>;
}

const siteOf = (ctx: Ctx) => (ctx.index ??= ctx.site.index().catch(() => []));


const marker = (id: string) => [`<!-- autopilot:${id} -->`, `<!-- /autopilot:${id} -->`];

function wrap(id: string, html: string) {
  const [start, end] = marker(id);
  return `${start}${html}${end}`;
}

/** Removes an autopilot block from a body, leaving anything else (including later edits) alone. */
function unwrap(id: string, body: string): string | null {
  const [start, end] = marker(id);
  const i = body.indexOf(start);
  const j = body.indexOf(end);
  if (i === -1 || j === -1 || j < i) return null;
  return body.slice(0, i) + body.slice(j + end.length);
}

export async function logChange(c: {
  accountId: string;
  runId: string | null;
  pageUrl: string;
  resourceType: string;
  resourceId: string;
  query: string;
  field: ChangeField;
  targetId?: string;
  before: string | null;
  after: string | null;
  reason?: string;
  status: string;
  op?: Opportunity;
  note?: string;
}): Promise<string> {
  const [row] = await sql`
    INSERT INTO insights_autopilot_changes
      (account_id, run_id, page_url, resource_type, resource_id, query, field, target_id, before_value, after_value, reason, status,
       baseline_position, baseline_clicks, baseline_impressions, note)
    VALUES (${c.accountId}, ${c.runId}, ${c.pageUrl}, ${c.resourceType}, ${c.resourceId}, ${c.query}, ${c.field}, ${c.targetId ?? null},
      ${c.before}, ${c.after}, ${c.reason ?? null}, ${c.status},
      ${c.op?.position ?? null}, ${c.op?.clicks ?? null}, ${c.op?.impressions ?? null}, ${c.note ?? null})
    RETURNING id`;
  return row.id!;
}

/** Words every post shares, which say nothing about whether two posts are on the same topic. */
const GENERIC = new Set(
  "best top guide guides buyer buyers review reviews supplement supplements vitamin vitamins what when which with your that this from about does work works ways tips need know complete ultimate review 2024 2025 2026 2027 benefits".split(" ")
);

/** Topic words of a title or search: no filler, no generic shopping words, plurals folded. */
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !GENERIC.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  );

// ---------- measuring ----------

/**
 * Today's position from the daily rank check, for sites without Search Console. Only a reading taken after `since`
 * (the day of the change, or of the control) counts: an older one would judge the change on how things were before it.
 */
async function trackedPosition(accountId: string, query: string, since: string | Date | null): Promise<{ position: number | null; clicks: number | null } | null> {
  if (!since) return null;
  const after = new Date(since).toISOString();
  const [row] = await sql`SELECT position FROM insights_rank_daily WHERE account_id = ${accountId} AND query = ${query.toLowerCase()}
    AND checked_on > ${after}::timestamptz::date
    ORDER BY checked_on DESC LIMIT 1`;
  if (!row) return null;
  // Not in the top 10 the check reads: recorded as exactly that (null), never as a made up position.
  // The rank check sees no clicks, so clicks are unknown (null), not zero.
  return { position: row.position === null ? null : Number(row.position), clicks: null };
}

/**
 * A Search Console reading, or null when there's no data. With no dimensions Search Console answers even an
 * unknown search with one empty summary row (0 impressions, position 0); that is "no data", never "ranked #0".
 */
export function gscReading(row: { position: number; clicks: number; impressions: number } | undefined | null) {
  if (!row || !(row.impressions > 0) || !(row.position >= 1)) return null;
  return row;
}

async function positionFor(conn: Connection, query: string, page: string) {
  const { current } = resolveRange("28d", 3);
  const body = await googleRequest<{ rows?: { position: number; clicks: number; impressions: number }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl!)}/searchAnalytics/query`,
    {
      startDate: current.start,
      endDate: current.end,
      dimensionFilterGroups: [{ filters: [
        { dimension: "query", operator: "equals", expression: query },
        { dimension: "page", operator: "equals", expression: page },
      ] }],
    }
  );
  return gscReading(body.rows?.[0]);
}

/** The baseline stored for a search that wasn't on page one before the change: a marker, not a real position. */
export const OFF_PAGE_ONE = 25;

/**
 * The verdict on one measured change. Worse means it fell more than WORSE_BY_POSITIONS places without gaining
 * clicks (unknown clicks count as no gain), or it left the top 10 the rank check reads after being in it.
 * No reading at all is never worse. A search that wasn't ranked before (the OFF_PAGE_ONE marker, or no baseline)
 * has no position to fall from, so it's worse only when its clicks fell, never on position alone.
 */
export function measuredWorse(
  baseline: number | null,
  now: { position: number | null; clicks: number | null } | null,
  baseClicks: number
): { worse: boolean; droppedOut: boolean } {
  if (!now) return { worse: false, droppedOut: false };
  if (baseline === null || !Number.isFinite(baseline) || baseline === OFF_PAGE_ONE) {
    return { worse: now.clicks !== null && now.clicks < baseClicks, droppedOut: now.position === null };
  }
  if (now.position === null) return { worse: baseline <= 10, droppedOut: true };
  return { worse: now.position > baseline + WORSE_BY_POSITIONS && (now.clicks === null || now.clicks <= baseClicks), droppedOut: false };
}

/**
 * Measures control pages the same way and at the same age as the changes they stand beside. Never changes a page.
 * A control whose page any agent changed meanwhile (a rescue, a link fix, a take down) is voided, and so is one
 * that couldn't be measured three times: neither counts in the comparison, and the page is free again.
 */
async function measureControls(ctx: Ctx, conn: Connection): Promise<void> {
  await sql`
    UPDATE insights_autopilot_controls k SET voided = 'Its page was changed during the four weeks.', evaluated_at = now()
    WHERE k.account_id = ${ctx.accountId} AND k.evaluated_at IS NULL AND EXISTS (
      SELECT 1 FROM insights_autopilot_changes c
      WHERE c.account_id = k.account_id AND c.created_at > k.created_at AND c.status IN ('applied', 'kept', 'reverted')
        AND rtrim(regexp_replace(c.page_url, '^https?://[^/]+', ''), '/') = rtrim(regexp_replace(k.page_url, '^https?://[^/]+', ''), '/')
    )`;
  const due = await sql`
    SELECT id, page_url, query, failures, created_at FROM insights_autopilot_controls
    WHERE account_id = ${ctx.accountId} AND evaluated_at IS NULL AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})
    ORDER BY measure_tried_at NULLS FIRST, created_at LIMIT 5`;
  for (const d of due) {
    let failed = false;
    const fromGsc = conn.gscSiteUrl
      ? await positionFor(conn, d.query!, d.page_url!).catch(() => {
          failed = true;
          return null;
        })
      : null;
    if (failed) {
      // Tried again later, behind the others; after three failures the page is let go.
      await sql`UPDATE insights_autopilot_controls SET measure_tried_at = now(), failures = failures + 1,
        voided = CASE WHEN failures + 1 >= 3 THEN 'Search Console could not measure it.' ELSE NULL END,
        evaluated_at = CASE WHEN failures + 1 >= 3 THEN now() ELSE NULL END
        WHERE id = ${d.id}`;
      continue;
    }
    const now = fromGsc ?? (await trackedPosition(ctx.accountId, d.query!, d.created_at).catch(() => null));
    await sql`UPDATE insights_autopilot_controls SET evaluated_at = now(), result_position = ${now?.position ?? null}, result_clicks = ${now?.clicks ?? null}
      WHERE id = ${d.id}`;
  }
}

/**
 * True when the changed page fell more than WORSE_BY_POSITIONS places further than its untouched control over the
 * same weeks; null when there's no usable control. Measures the control now (and records it) so both readings match.
 */
async function fellMoreThanControl(ctx: Ctx, conn: Connection, runId: string, baseline: number, nowPos: number | null): Promise<boolean | null> {
  const [k] = await sql`SELECT id, page_url, query, baseline_position, evaluated_at, result_position, created_at FROM insights_autopilot_controls
    WHERE account_id = ${ctx.accountId} AND run_id = ${runId} AND voided IS NULL AND baseline_position <> 25 LIMIT 1`;
  if (!k || nowPos === null) return null;
  // Already measured (the controls' own pass got to it first): its stored reading is used.
  if (k.evaluated_at) return k.result_position === null ? null : relativeFall(baseline, nowPos, Number(k.baseline_position), Number(k.result_position)) > WORSE_BY_POSITIONS;
  // A Search Console error is thrown, so this change waits and retries like any other.
  const fromGsc = conn.gscSiteUrl ? await positionFor(conn, k.query!, k.page_url!) : null;
  const c = fromGsc ?? (await trackedPosition(ctx.accountId, k.query!, k.created_at));
  if (!c || c.position === null) return null;
  await sql`UPDATE insights_autopilot_controls SET evaluated_at = now(), result_position = ${c.position}, result_clicks = ${c.clicks ?? null} WHERE id = ${k.id}`;
  return relativeFall(baseline, nowPos, Number(k.baseline_position), c.position) > WORSE_BY_POSITIONS;
}

/** How many more places the changed page fell than its control (negative: it did better). */
export const relativeFall = (base: number, now: number, ctlBase: number, ctlNow: number) => now - base - (ctlNow - ctlBase);

/** Looks at pages changed at least 4 weeks ago; keeps what helped and undoes what hurt. */
async function measureOlderChanges(ctx: Ctx, conn: Connection): Promise<{ notes: string[]; undoFailures: number }> {
  const due = await sql`
    SELECT run_id, page_url, query, min(baseline_position) AS baseline_position, min(baseline_clicks) AS baseline_clicks, min(created_at) AS made
    FROM insights_autopilot_changes
    WHERE account_id = ${ctx.accountId} AND status = 'applied' AND field <> 'prune' AND run_id IS NOT NULL
      AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})
    GROUP BY run_id, page_url, query
    ORDER BY max(measure_tried_at) NULLS FIRST, min(created_at)
    LIMIT 5`;
  const notes: string[] = [];
  let undoFailures = 0;
  const updates = due.length ? await googleUpdates().catch(() => [] as GoogleUpdate[]) : [];
  for (const d of due) {
    // Nothing to compare with (a new article had no position before it existed): kept, never judged on a made up
    // starting point. The Pruning agent judges new articles on their own data after three months.
    if (d.baseline_position === null) {
      const now = conn.gscSiteUrl ? await positionFor(conn, d.query!, d.page_url!).catch(() => null) : null;
      await sql`UPDATE insights_autopilot_changes SET status = 'kept', evaluated_at = now(),
        result_position = ${now?.position ?? null}, result_clicks = ${now?.clicks ?? null},
        note = ${"No position before this change to compare with; kept. New articles are judged by the Pruning agent."}
        WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND query = ${d.query} AND status = 'applied' AND field <> 'prune'
          AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})`;
      notes.push(`Kept the new page for “${d.query}”: nothing before it to compare with.`);
      continue;
    }
    // Search Console first; when it has nothing for this search yet (a new property), the daily Google rank check.
    // If Search Console errors, this change waits for the next run rather than being judged on weaker data.
    let gscFailed = false;
    const fromGsc = conn.gscSiteUrl
      ? await positionFor(conn, d.query!, d.page_url!).catch(() => {
          gscFailed = true;
          return null;
        })
      : null;
    if (gscFailed) {
      await sql`UPDATE insights_autopilot_changes SET measure_tried_at = now()
        WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND status = 'applied'`;
      notes.push(`Measuring “${d.query}” waits: Search Console didn't answer.`);
      continue;
    }
    const now: { position: number | null; clicks: number | null } | null =
      fromGsc ?? (await trackedPosition(ctx.accountId, d.query!, d.made).catch(() => null));
    const baseline = Number(d.baseline_position);
    const baseClicks = Number(d.baseline_clicks ?? 0);
    const verdict = measuredWorse(baseline, now, baseClicks);
    const { droppedOut } = verdict;
    // Measured across a Google update: it moved every site, so a fall isn't blamed on the change (never undone),
    // and the result is kept apart from clean ones.
    const across = updatesDuring(updates, new Date(String(d.made)), new Date()).map((u) => u.name).join(", ") || null;
    // Across a core update the change is judged against its untouched control: undone only when it fell more
    // than the control did. Without a control there's no fair verdict, so it's kept.
    let worse = verdict.worse;
    if (across && worse) {
      let rel: boolean | null;
      try {
        rel = await fellMoreThanControl(ctx, conn, String(d.run_id), baseline, now?.position ?? null);
      } catch {
        await sql`UPDATE insights_autopilot_changes SET measure_tried_at = now() WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND status = 'applied'`;
        notes.push(`Measuring “${d.query}” waits: its control couldn't be read.`);
        continue;
      }
      worse = rel === true;
    }
    const changes = await sql`
      SELECT * FROM insights_autopilot_changes
      WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND status = 'applied'
        -- Only changes that have had their four weeks: a fix done by hand later (dated when it was done) waits for its own.
        AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})
      ORDER BY id DESC`;
    const failed: string[] = [];
    const unranked = baseline === OFF_PAGE_ONE;
    for (const c of changes) {
      if (worse) {
        const note = await revertRow(ctx, c, { checkLive: true }).catch((e) => {
          failed.push((e as Error).message);
          return `Undo failed: ${(e as Error).message}`;
        });
        const why = unranked
          ? `Clicks fell from ${baseClicks} to ${now!.clicks}.`
          : droppedOut
            ? `Dropped out: was ${baseline.toFixed(1)}, no longer in the top 10 checked.`
            : `Ranking dropped from ${baseline.toFixed(1)} to ${now!.position!.toFixed(1)}${across ? `, more than its untouched control during Google's ${across}` : ""}.`;
        // A failed undo stays live and is tried again, behind the other changes waiting to be measured.
        await sql`UPDATE insights_autopilot_changes SET evaluated_at = now(), measure_tried_at = now(), result_position = ${now!.position}, result_clicks = ${now!.clicks},
          across_update = ${across},
          note = ${`${why} ${note}`} WHERE id = ${c.id}`;
      } else {
        await sql`UPDATE insights_autopilot_changes SET status = 'kept', evaluated_at = now(), across_update = ${across},
          result_position = ${now?.position ?? null}, result_clicks = ${now?.clicks ?? null},
          note = ${across && verdict.worse ? `Fell, but measured across Google's ${across} and not more than its untouched control (or with no control), so it wasn't undone.` : now && now.position !== null ? (unranked ? `Not on page one before; now ${now.position.toFixed(1)}` : `Position ${baseline.toFixed(1)} → ${now.position.toFixed(1)}`) : droppedOut ? "Not in the top 10 the rank check reads, and it wasn't there before either; kept." : "Not enough search data yet to compare; kept."} WHERE id = ${c.id}`;
      }
    }
    const during = across ? ` (measured across Google's ${across})` : "";
    if (failed.length) {
      undoFailures += failed.length;
      notes.push(`Couldn't undo ${failed.length} of ${changes.length} changes for “${d.query}”${during}: ${failed[0]} They stay live and are tried again next run.`);
    } else {
      notes.push(`${worse ? "Undid" : "Kept"} changes for “${d.query}”${during}`);
    }
  }
  return { notes, undoFailures };
}

// ---------- improving ----------

/** Legal, contact, account and similar pages on any website: never rewritten. */
const PROTECTED_ANY = /\/(contact|privacy|terms|refund|returns?|shipping|polic(y|ies)|legal|cookies?|accessibility|disclaimer|cart|checkout|account|login|search|tag|tags|author|category|categories)(\/|$)/i;

/**
 * The best candidate on a page the autopilot may change. On Shopify that's a
 * blog post, page, product or collection; on any other website it's any
 * content page (not the home page, legal or utility pages).
 */
function pickTarget(cands: Candidate[], brand: string, rested: (c: Candidate) => boolean, shopify: boolean): Candidate | null {
  return (
    cands.find((c) => {
      const path = new URL(c.op.page).pathname;
      const editable = shopify
        ? /^\/(blogs\/[^/]+\/[^/]+|pages|products|collections)\//.test(path + "/")
        : path.replace(/\/+$/, "") !== "" && !PROTECTED_ANY.test(path);
      return !(brand && c.op.query.includes(brand)) && !rested(c) && !PROTECTED_PAGE.test(path) && editable;
    }) ?? null
  );
}

const score = (c: Candidate) => clickGain(c.op) * Object.values(c.weights).reduce((a, w) => a * w, 1);
const MODE_ORDER: Record<Mode, number> = { defend: 0, top: 1, climb: 1 };

/** Every ready app suggests candidates and enriches all of them; defend comes first, then the biggest gain. */
async function gatherCandidates(hub: Hub, apps: RankingApp[], notes: string[]): Promise<Candidate[]> {
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  for (const app of apps) {
    if (!app.candidates) continue;
    const found = await app.candidates(hub).catch((e) => {
      notes.push(`${app.name} couldn't suggest pages: ${(e as Error).message}`);
      return [];
    });
    for (const c of found) {
      if (seen.has(keyOf(c.op))) {
        // A later app may know it's slipping when an earlier one only saw room to climb.
        const existing = cands.find((x) => keyOf(x.op) === keyOf(c.op))!;
        if (c.mode === "defend" && existing.mode !== "defend") Object.assign(existing, { mode: "defend", previousPosition: c.previousPosition });
        continue;
      }
      seen.add(keyOf(c.op));
      cands.push(c);
    }
  }
  for (const app of apps) {
    if (app.enrich) await app.enrich(hub, cands).catch((e) => notes.push(`${app.name} was skipped: ${(e as Error).message}`));
  }
  return cands.sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || score(b) - score(a));
}

/** Every ready app briefs the writer on the chosen target, in order. */
async function gatherBriefs(hub: Hub, apps: RankingApp[], cand: Candidate, notes: string[]) {
  const briefs: string[] = [];
  const summaries: string[] = [];
  const used: string[] = [];
  for (const app of apps) {
    if (!app.brief) continue;
    // A page topic isn't a real search: don't study page one or search volumes for it.
    if (cand.inferred && (app.id === "page-one" || app.id === "keyword-planner")) continue;
    const b = await app.brief(hub, cand).catch((e) => {
      notes.push(`${app.name} was skipped: ${(e as Error).message}`);
      return null;
    });
    if (!b) continue;
    if (b.text) briefs.push(b.text);
    if (b.summary) summaries.push(b.summary);
    used.push(app.name);
  }
  return { briefs, summaries, used };
}

interface Plan {
  cand: Candidate;
  page: StoreResource;
  improvement: PageImprovement;
  summaries: string[];
  apps: string[];
  /** A similar page left untouched for the same four weeks, to tell the change's effect from Google's own swings. */
  control?: Candidate | null;
}

/**
 * The control for a change: another page with a real search ranking near the same position (within 30%, at least
 * 3 places), not changed lately, not the same search. Null when none is close enough: no control beats a bad one.
 */
/** The path of a page address, full or already a path. */
const pathOfUrl = (u: string) => {
  try {
    return new URL(u, "https://x").pathname.replace(/\/$/, "") || "/";
  } catch {
    return u;
  }
};

export function pickControl(cand: Candidate, cands: Candidate[], blocked: (c: Candidate) => boolean): Candidate | null {
  const pos = cand.op.position;
  if (cand.inferred || !Number.isFinite(pos) || pos === 25) return null;
  const room = Math.max(3, pos * 0.3);
  return (
    cands
      .filter((c) => c.op.page !== cand.op.page && c.op.query !== cand.op.query && !c.inferred && c.op.position !== 25 && !blocked(c))
      .filter((c) => Math.abs(c.op.position - pos) <= room)
      .sort((a, b) => Math.abs(a.op.position - pos) - Math.abs(b.op.position - pos))[0] ?? null
  );
}

/** Targets tried per run when the writer finds a page can't match what searchers want. */
const MAX_WRITES_PER_RUN = 3;

/**
 * Picks the page and has the writer plan the change. Nothing is written to the
 * store. A target whose page can't give searchers what they want is set aside
 * as a content gap (logged unless `recordGap` is null) and the next one is tried.
 */
async function planNextChange(
  ctx: Ctx,
  conn: Connection,
  notes: string[],
  recordGap: ((cand: Candidate, page: StoreResource, idea: string) => Promise<void>) | null
): Promise<Plan | null> {
  let results: Promise<string[]> | undefined;
  const hub: Hub = { accountId: ctx.accountId, conn, platform: ctx.platform, ourDomain: ctx.ourDomain, shared: new Map() };
  const apps = await readyApps(hub);
  const all = await gatherCandidates(hub, apps, notes);
  // Urgent: winning back a slipping search, or getting a page Google left out into its index.
  const unindexed = (c: Candidate) => (c.weights["site-health"] ?? 0) >= 4;
  const cands = ctx.indexOnly ? all.filter(unindexed) : ctx.urgentOnly ? all.filter((c) => c.mode === "defend" || unindexed(c)) : all;
  if (ctx.urgentOnly) notes.push(`Urgent check: ${cands.length} urgent of ${all.length} candidates${cands.length ? ` (${cands.slice(0, 3).map((c) => `“${c.op.query}” on ${new URL(c.op.page).pathname}`).join(", ")})` : ""}.`);

  const changedSince = async (days: number) =>
    new Set(
      (await sql`SELECT DISTINCT page_url FROM insights_autopilot_changes
        WHERE account_id = ${ctx.accountId} AND status IN ('applied', 'kept', 'reverted', 'skipped', 'suggested') AND created_at > now() - make_interval(days => ${days})`).map(
        (r) => r.page_url!
      )
    );
  const [restedLong, restedShort] = await Promise.all([changedSince(REST_DAYS_PER_PAGE), changedSince(DEFEND_REST_DAYS)]);
  const skipped = new Set<string>();
  // Pages held as controls stay untouched until they're measured.
  const controls = new Set(
    (await sql`SELECT page_url FROM insights_autopilot_controls WHERE account_id = ${ctx.accountId} AND evaluated_at IS NULL`.catch(() => [])).map((r) => r.page_url!)
  );
  ctx.controlPaths = new Set([...controls].map(pathOfUrl));
  // A control page waits, except to be rescued: a slipping page or urgent fix goes first (and its control is voided).
  const held = (c: Candidate) => controls.has(c.op.page) && c.mode !== "defend" && !ctx.urgentOnly;
  const rested = (c: Candidate) => skipped.has(c.op.page) || held(c) || (c.mode === "defend" ? restedShort : restedLong).has(c.op.page);
  const brand = ctx.ourDomain.split(".")[0];

  for (let writes = 0; writes < MAX_WRITES_PER_RUN; writes++) {
    let cand = pickTarget(cands, brand, rested, ctx.site.mode === "shopify");
    let page: StoreResource | null = null;
    // Skip pages that don't map to an editable store item, and pages losing a search to another of the site's pages.
    for (let tries = 0; cand && tries < 8; tries++) {
      page = await ctx.site.resolve(cand.op.page).catch(() => null);
      const rival = page ? strongerRival(cand.op.page, await pagesForQuery(conn, cand.op.query).catch(() => [])) : null;
      if (page && !rival) break;
      if (rival) {
        notes.push(
          `Left ${new URL(cand.op.page).pathname} alone for “${cand.op.query}”: ${new URL(rival.page).pathname} gets more of that search, and two pages competing hold each other back. Only the stronger page is worked on.`
        );
      }
      page = null;
      skipped.add(cand.op.page);
      cand = pickTarget(cands, brand, rested, ctx.site.mode === "shopify");
    }
    if (!cand || !page) return null;

    const { briefs, summaries, used } = await gatherBriefs(hub, apps, cand, notes);
    // What this site's own past changes did, measured: the writer and its reviewer learn from it.
    briefs.unshift(...(await (results ??= measuredResults(ctx.accountId).then(async (r) => [...r, ...(await lessons(ctx.accountId).catch(() => []))]).catch(() => []))));
    const improvement = await writeImprovement(
      ctx.ai,
      page,
      {
        query: cand.inferred ? `(no target search yet; page topic: ${cand.op.query})` : cand.op.query,
        position: cand.op.position,
        impressions: cand.op.impressions,
        mode: cand.mode,
        previousPosition: cand.previousPosition,
      },
      briefs,
      ctx.allowContent
    );
    if (improvement.reviewNote) notes.push(`${new URL(cand.op.page).pathname}: ${improvement.reviewNote}`);
    if (improvement.intentMatch) {
      const control = pickControl(cand, all, (c) => rested(c) || controls.has(c.op.page));
      if (control) ctx.controlPaths.add(pathOfUrl(control.op.page));
      return { cand, page, improvement: await guardDuplicates(ctx, page, improvement, notes), summaries, apps: used, control };
    }

    const idea = improvement.missingForIntent || "People searching this want something the page doesn't have yet.";
    notes.push(`Skipped “${cand.op.query}” on ${new URL(cand.op.page).pathname}: ${idea}`);
    await recordGap?.(cand, page, idea).catch(() => undefined);
    skipped.add(cand.op.page);
  }
  return null;
}

/** No title or description another page already uses, no section copied from another page or repeating this one. */
async function guardDuplicates(ctx: Ctx, page: StoreResource, imp: PageImprovement, notes: string[]): Promise<PageImprovement> {
  const site = await siteOf(ctx);
  const path = new URL(page.url).pathname;
  const out = { ...imp };
  const titleTwin = out.metaTitle && out.metaTitle !== page.metaTitle ? duplicateOf(out.metaTitle, path, site, "title") : null;
  if (titleTwin) {
    notes.push(`Kept the current SEO title: the new one was nearly the same as ${titleTwin.path}'s.`);
    out.metaTitle = page.metaTitle ?? "";
  }
  const descTwin =
    out.metaDescription && out.metaDescription !== page.metaDescription ? duplicateOf(out.metaDescription, path, site, "description") : null;
  if (descTwin) {
    notes.push(`Kept the current meta description: the new one was nearly the same as ${descTwin.path}'s.`);
    out.metaDescription = page.metaDescription ?? "";
  }
  if (out.contentSectionHtml) {
    const cache = new Map<string, Set<string>>();
    const self: SiteItem = { path: "this page", kind: page.type, title: page.title, seoTitle: "", seoDescription: null, text: plainText(page.body) };
    const others = [self, ...site.filter((i) => i.path !== path)];
    const sources = new Set<string>();
    out.contentSectionHtml = dropBlocks(out.contentSectionHtml, (text) => {
      const from = copiedFrom(text, path, others, cache);
      if (from) sources.add(from.path);
      return Boolean(from);
    });
    if (sources.size) notes.push(`Dropped new paragraphs that repeated ${[...sources].join(", ")}.`);
    if (!blocksOf(out.contentSectionHtml).length) out.contentSectionHtml = "";
  }
  return out;
}

/** The other blog post most related to the page, that doesn't link to it yet. */
async function linkSource(ctx: Ctx, cand: Candidate, page: StoreResource) {
  const path = new URL(cand.op.page).pathname;
  const topic = words(`${cand.op.query} ${page.title}`);
  return (await ctx.site.articles())
    // Never a page held as a control: it must stay untouched.
    .filter((a) => a.url !== path && !a.body.includes(path) && !ctx.controlPaths?.has(pathOfUrl(a.url)))
    .map((a) => ({ a, score: [...words(a.title)].filter((w) => topic.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)[0]?.a;
}

/** Structured data the page should get, or null. */
async function schemaFor(ctx: Ctx, page: StoreResource, body: string): Promise<string | null> {
  const [live, name] = await Promise.all([liveHtml(page.url), ctx.site.name().catch(() => ctx.ourDomain)]);
  return buildSchema(page, body, live, name);
}

/**
 * For sites the app can't edit: the same changes, saved as a fix list for the
 * owner to paste in. Marked done, they're measured like any other change.
 */
async function suggestPlan(ctx: Ctx, runId: string, plan: Plan): Promise<string[]> {
  const { cand, page, improvement } = plan;
  const op = cand.op;
  const done: string[] = [];
  const base = { accountId: ctx.accountId, runId, pageUrl: op.page, resourceType: "site", resourceId: page.url, query: op.query, reason: improvement.reason, op };
  const suggest = async (field: ChangeField, before: string | null, after: string, targetId?: string) => {
    await logChange({ ...base, field, before, after, status: "suggested", targetId });
    done.push(field);
  };
  if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) await suggest("meta_title", page.metaTitle, improvement.metaTitle);
  if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription) {
    await suggest("meta_description", page.metaDescription, improvement.metaDescription);
  }
  if (improvement.contentSectionHtml) await suggest("content", null, improvement.contentSectionHtml);
  const body = improvement.contentSectionHtml ? `${page.body}\n${improvement.contentSectionHtml}` : page.body;
  const schema = await schemaFor(ctx, { ...page, metaDescription: improvement.metaDescription || page.metaDescription }, body).catch(() => null);
  if (schema) await suggest("schema", null, withoutAutopilotSchema(schema).trim() || schema);
  // No internal link built around a page topic that isn't a real search.
  const source = cand.inferred ? undefined : await linkSource(ctx, cand, page).catch(() => undefined);
  if (source) {
    const sentence = await writeInternalLink(ctx.ai, source, { path: new URL(op.page).pathname, query: op.query, title: page.title });
    if (sentence) await suggest("internal_link", null, sentence, source.id);
  }
  return done;
}

/**
 * With the owner as the check: every change is saved exactly as it would be written, marked as waiting, and goes live
 * only when the owner approves it (approveChange). Structured data is added when a section is approved.
 */
async function holdPlan(ctx: Ctx, runId: string, plan: Plan, w: SiteWriter): Promise<string[]> {
  const { cand, page, improvement } = plan;
  const op = cand.op;
  const done: string[] = [];
  const resourceType = ctx.site.mode === "snippet" ? "snippet" : page.type;
  const base = { accountId: ctx.accountId, runId, pageUrl: op.page, resourceType, resourceId: page.id, query: op.query, reason: improvement.reason, op };
  const can = async (field: ChangeField, id: string) => !w.supports || (await w.supports(field, id).catch(() => false));
  const hold = async (field: ChangeField, before: string | null, after: string, targetId?: string) => {
    // A newer version replaces the one still waiting for this page, so the owner never approves two of the same change.
    await replaceWaiting(ctx.accountId, op.page, field, field === "alt" ? targetId : undefined);
    await logChange({ ...base, field, before, after, status: "suggested", targetId, note: OWNER_APPROVAL });
    done.push(field);
  };
  // What this platform can't change goes on the fix list, as when the autopilot writes on its own.
  const fix = async (field: ChangeField, before: string | null, after: string, targetId?: string) => {
    await logChange({ ...base, resourceType: "site", resourceId: page.url, field, before, after, status: "suggested", targetId });
    done.push(field);
  };
  if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) {
    await ((await can("meta_title", page.id)) ? hold : fix)("meta_title", page.metaTitle, improvement.metaTitle);
  }
  if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription) {
    await ((await can("meta_description", page.id)) ? hold : fix)("meta_description", page.metaDescription, improvement.metaDescription);
  }
  if (w.setAlt) for (const a of improvement.altTexts) await hold("alt", null, a.alt, a.imageId);
  if (improvement.contentSectionHtml && (page.type === "article" || page.type === "page")) {
    const blockId = `${runId}-content`;
    if (await can("content", page.id)) await hold("content", blockId, wrap(blockId, improvement.contentSectionHtml));
    else await fix("content", null, improvement.contentSectionHtml);
  }
  // Structured data is built when the owner approves a section, from the page as it really is then (addSchema in
  // approveChange), so it never describes text that isn't live.
  const source = cand.inferred ? undefined : await linkSource(ctx, cand, page).catch(() => undefined);
  if (source) {
    const sentence = await writeInternalLink(ctx.ai, source, { path: new URL(op.page).pathname, query: op.query, title: page.title });
    if (sentence) {
      const blockId = `${runId}-link`;
      if (await can("internal_link", source.id)) await hold("internal_link", blockId, wrap(blockId, sentence), source.id);
      else await fix("internal_link", null, sentence, new URL(source.url, op.page).href);
    }
  }
  return done;
}

/** Skips what still waits for the owner's approval for this page and field, when a newer version replaces it. */
async function replaceWaiting(accountId: string, pageUrl: string, field: ChangeField, targetId?: string): Promise<void> {
  // Alt texts are one per image: only the same image's earlier one is replaced.
  await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'Replaced by a newer change for this page.'
    WHERE account_id = ${accountId} AND status = 'suggested' AND resource_type <> 'site' AND page_url = ${pageUrl} AND field = ${field}
      AND (${targetId ?? null}::text IS NULL OR target_id = ${targetId ?? null})`;
}

/** The owner approved a change that waited for them: it is written to the site now and measured from today. */
export async function approveChange(accountId: string, id: string): Promise<void> {
  await ensureSchema();
  const [c] = await sql`SELECT * FROM insights_autopilot_changes WHERE id = ${id} AND account_id = ${accountId} AND status = 'suggested'`;
  if (!c) throw new Error("That change isn't waiting anymore.");
  if (c.resource_type === "site") throw new Error("This one goes in by hand: copy it into your site, then mark it done.");
  const site = await siteFor(accountId);
  const w = site?.writer;
  if (!w) throw new Error("Connect your website first, so approved changes can go live.");
  const after = String(c.after_value ?? "");
  const type = (c.resource_type === "article" ? "article" : "page") as "article" | "page";
  // Undo puts back what is live now (the owner may have edited it since), not what was there when it was written.
  let before: string | null = c.before_value ?? null;
  if (c.field === "meta_title" || c.field === "meta_description") {
    const live = await site!.resolve(String(c.page_url)).catch(() => null);
    if (live) before = (c.field === "meta_title" ? live.metaTitle : live.metaDescription) ?? null;
  }
  const append = async (bodyType: "article" | "page", resourceId: string) => {
    const body = await w.getBody(bodyType, resourceId);
    // Already there (approved twice, or added by hand): nothing to add.
    if (c.before_value && body.includes(`<!-- autopilot:${c.before_value} -->`)) return;
    await w.setBodyIfUnchanged(bodyType, resourceId, body, `${body}\n${after}`);
  };
  let note = "Approved by you.";
  try {
    if (c.field === "meta_title") await w.setSeo(String(c.resource_id), "title", after);
    else if (c.field === "meta_description") await w.setSeo(String(c.resource_id), "description", after);
    else if (c.field === "alt" && w.setAlt && c.target_id) await w.setAlt(String(c.target_id), after);
    else if (c.field === "content") await append(type, String(c.resource_id));
    else if (c.field === "internal_link" && c.target_id) await append("article", String(c.target_id));
    else if (c.field === "schema") {
      if (w.setSchema) await w.setSchema(type, String(c.resource_id), after);
      else {
        const body = await w.getBody(type, String(c.resource_id));
        await w.setBodyIfUnchanged(type, String(c.resource_id), body, `${withoutAutopilotSchema(body)}\n${after}`);
      }
    } else throw new Error("This kind of change can't be published from here yet. Copy it into your site, then mark it done.");
  } catch (err) {
    const name = (err as Error).name;
    // Saved, live at the owner's next publish (Webflow with other unpublished work): it counts as done.
    if (name === "SavedNotLive") note = "Approved by you. Saved; it goes live when you next publish your site.";
    else if (err instanceof EditedMeanwhile) throw new Error("The page changed while this was being approved. Try again.");
    else if (name === "UnpublishedDraft") throw new Error("This page has unpublished edits of your own. Publish or discard them, then approve again.");
    else throw err;
  }
  // Measured from today: the same Search Console reading the measurement compares against, taken now.
  const conn = await getConnection(accountId).catch(() => null);
  // Read the same way the measurement reads it: Search Console first, then the daily rank check. Without a reading,
  // the baseline stored when the change was written stays.
  const gsc = conn?.gscSiteUrl && c.query ? await positionFor(conn, String(c.query), String(c.page_url)).catch(() => null) : null;
  const tracked = !gsc && c.query ? await trackedPosition(accountId, String(c.query), new Date(Date.now() - 3 * 86400_000)).catch(() => null) : null;
  const position = gsc ? gsc.position : tracked ? (tracked.position ?? OFF_PAGE_ONE) : null;
  await sql`UPDATE insights_autopilot_changes SET status = 'applied', created_at = now(), note = ${note}, before_value = ${before},
      baseline_position = COALESCE(${position}::real, baseline_position),
      baseline_clicks = CASE WHEN ${gsc ? 1 : 0}::int = 1 THEN ${gsc?.clicks ?? null}::real ELSE baseline_clicks END,
      baseline_impressions = CASE WHEN ${gsc ? 1 : 0}::int = 1 THEN ${gsc?.impressions ?? null}::real ELSE baseline_impressions END
    WHERE id = ${id} AND account_id = ${accountId} AND status = 'suggested'`;
  // A section that went live gets structured data built from the page as it is now (undone with it, same run).
  if (c.field === "content" && (type === "article" || type === "page")) {
    await addSchema(accountId, c.run_id ? String(c.run_id) : null, site!, w, String(c.page_url), type, String(c.resource_id), String(c.query ?? "")).catch(async (e) => {
      // Visible on the change itself, not only in the logs.
      await sql`UPDATE insights_autopilot_changes SET note = ${`${note} Structured data couldn't be added this time: ${(e as Error).message}`.slice(0, 500)} WHERE id = ${id}`.catch(() => undefined);
    });
  }
  // Tell Google about the change now instead of waiting for its next visit.
  if (conn) await askGoogleToRecrawl(conn).catch(() => null);
}

/** Structured data for a page whose approved section is now live, built from its real body, logged like any change. */
async function addSchema(accountId: string, runId: string | null, site: SiteAccess, w: SiteWriter, pageUrl: string, type: "article" | "page", id: string, query: string): Promise<void> {
  if (w.supports && !(await w.supports("schema", id).catch(() => false))) return;
  const page = await site.resolve(pageUrl);
  if (!page) return;
  const body = await w.getBody(type, id);
  const [live, name] = await Promise.all([liveHtml(page.url), site.name().catch(() => new URL(pageUrl).hostname)]);
  const schema = buildSchema(page, body, live, name);
  if (!schema) return;
  const blockId = `${runId ?? `approved-${Date.now()}`}-schema`;
  const block = wrap(blockId, schema);
  if (w.setSchema) await w.setSchema(type, id, block);
  else await w.setBodyIfUnchanged(type, id, body, `${withoutAutopilotSchema(body)}\n${block}`);
  await logChange({ accountId, runId, pageUrl, resourceType: type, resourceId: id, query, field: "schema", before: blockId, after: block, reason: "Structured data built from the page after you approved its new section.", status: "applied" });
}

async function applyPlan(ctx: Ctx, runId: string, plan: Plan): Promise<string[]> {
  const w = ctx.site.writer;
  if (!w) return suggestPlan(ctx, runId, plan);
  if (ctx.ownerApproves) return holdPlan(ctx, runId, plan, w);
  const { cand, page, improvement } = plan;
  const op = cand.op;
  const done: string[] = [];
  // Snippet sites: the logged change is what the snippet serves on that page.
  const resourceType = ctx.site.mode === "snippet" ? "snippet" : page.type;
  const base = { accountId: ctx.accountId, runId, pageUrl: op.page, resourceType, resourceId: page.id, query: op.query, reason: improvement.reason, op };

  const apply = async (field: ChangeField, before: string | null, after: string, run: () => Promise<void>, targetId?: string) => {
    try {
      await run();
      await logChange({ ...base, field, before, after, status: "applied", targetId });
      done.push(field);
    } catch (err) {
      // Saved, but live only at the owner's next publish (Webflow with other unpublished work).
      const saved = (err as Error).name === "SavedNotLive";
      // The owner's own unpublished edits (Wix) are never published by the app: skipped like an edit made meanwhile.
      const status = saved ? "applied" : err instanceof EditedMeanwhile || (err as Error).name === "UnpublishedDraft" ? "skipped" : "failed";
      await logChange({ ...base, field, before, after, status, targetId, note: (err as Error).message });
      if (saved) done.push(field);
    }
  };
  // What this platform can't change for this page goes on the fix list instead.
  const can = async (field: ChangeField, id: string) => !w.supports || (await w.supports(field, id).catch(() => false));
  const suggest = async (field: ChangeField, before: string | null, after: string, targetId?: string) => {
    await logChange({ ...base, resourceType: "site", resourceId: page.url, field, before, after, status: "suggested", targetId });
    done.push(field);
  };

  if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) {
    if (await can("meta_title", page.id)) await apply("meta_title", page.metaTitle, improvement.metaTitle, () => w.setSeo(page.id, "title", improvement.metaTitle));
    else await suggest("meta_title", page.metaTitle, improvement.metaTitle);
  }
  if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription) {
    if (await can("meta_description", page.id)) {
      await apply("meta_description", page.metaDescription, improvement.metaDescription, () => w.setSeo(page.id, "description", improvement.metaDescription));
    } else await suggest("meta_description", page.metaDescription, improvement.metaDescription);
  }
  if (w.setAlt) {
    for (const a of improvement.altTexts) await apply("alt", null, a.alt, () => w.setAlt!(a.imageId, a.alt), a.imageId);
  }
  const canContent = await can("content", page.id);
  if (improvement.contentSectionHtml && (page.type === "article" || page.type === "page")) {
    const blockId = `${runId}-content`;
    const block = wrap(blockId, improvement.contentSectionHtml);
    if (canContent) await apply("content", blockId, block, () => w.setBodyIfUnchanged(page.type as "article" | "page", page.id, page.body, `${page.body}\n${block}`));
    else await suggest("content", null, improvement.contentSectionHtml);
  }

  // Structured data, rebuilt from the page as it is now (including any new FAQ).
  if ((page.type === "article" || page.type === "page") && !(await can("schema", page.id))) {
    const body = improvement.contentSectionHtml ? `${page.body}\n${improvement.contentSectionHtml}` : page.body;
    const schema = await schemaFor(ctx, { ...page, metaDescription: improvement.metaDescription || page.metaDescription }, body).catch(() => null);
    if (schema) await suggest("schema", null, schema);
  } else if (page.type === "article" || page.type === "page") {
    const type = page.type;
    const fetched = await w.getBody(type, page.id).catch(() => null);
    // Platforms without a text API (Wix) build structured data from the page as visitors see it.
    const current = fetched || (w.setSchema ? `${page.body}\n${improvement.contentSectionHtml}` : fetched);
    const updated = { ...page, metaDescription: improvement.metaDescription || page.metaDescription };
    const plan = current === null ? null : await schemaFor(ctx, updated, current);
    if (current !== null && plan) {
      const blockId = `${runId}-schema`;
      const block = wrap(blockId, plan);
      await apply("schema", blockId, block, () =>
        w.setSchema ? w.setSchema(type, page.id, block) : w.setBodyIfUnchanged(type, page.id, current, `${withoutAutopilotSchema(current)}\n${block}`)
      );
    }
  }

  const source = cand.inferred ? undefined : await linkSource(ctx, cand, page);
  if (source) {
    const path = new URL(op.page).pathname;
    const sentence = await writeInternalLink(ctx.ai, source, { path, query: op.query, title: page.title });
    if (sentence) {
      const blockId = `${runId}-link`;
      const block = wrap(blockId, sentence);
      if (await can("internal_link", source.id)) {
        await apply("internal_link", blockId, block, () => w.setBodyIfUnchanged("article", source.id, source.body, `${source.body}\n${block}`), source.id);
      } else await suggest("internal_link", null, sentence, new URL(source.url, op.page).href);
    }
  }
  return done;
}

function describe(cand: Candidate): string {
  const path = new URL(cand.op.page).pathname;
  const volume = cand.op.monthlySearches ? `, ${cand.op.monthlySearches.toLocaleString("en-US")} searches a month` : "";
  return cand.mode === "defend"
    ? `Defended ${path} for “${cand.op.query}” (slipped from ${cand.previousPosition?.toFixed(1) ?? "page 1"} to ${cand.op.position.toFixed(1)}${volume})`
    : cand.mode === "top"
      ? `Pushed ${path} for #1 on “${cand.op.query}” (now ${cand.op.position.toFixed(1)}${volume})`
      : `Improved ${path} for “${cand.op.query}” (now ${cand.op.position.toFixed(1)}${volume})`;
}

export interface RunResult {
  run: AutopilotRun | null;
  message: string;
  preview?: AutopilotPreview;
}

type Trigger = "schedule" | "manual" | "preview";

/**
 * One autopilot pass for one customer. Improves at most one page per call.
 * A "preview" goes through every step on live data but changes nothing: no
 * store edits, no measuring or undoing, and it doesn't count as a run.
 */
/** Note on every change that waits for the owner because no second AI checks the work yet. */
export const OWNER_APPROVAL = "Waiting for your approval: no second AI checks the work yet, so nothing goes live until you approve it.";

export async function runAutopilot(accountId: string, conn: Connection | null, trigger: Trigger): Promise<RunResult> {
  const ai = aiProvider(await readPlatformSettings());
  return ownerApproves(ai, () => runAutopilotChecked(accountId, conn, trigger, !hasSecondAi(ai)));
}

async function runAutopilotChecked(accountId: string, conn: Connection | null, trigger: Trigger, owner: boolean): Promise<RunResult> {
  await ensureSchema();
  const [acct, platform] = await Promise.all([readAccountAutopilot(accountId), readPlatformSettings()]);
  if (trigger === "schedule" && !acct.enabled) return { run: null, message: "Autopilot is turned off." };
  if (!conn) return { run: null, message: "Connect Google first." };
  const baseAi = aiProvider(platform);
  if (!baseAi) return { run: null, message: "Autopilot isn't available yet." };
  const profile = await readProfile(accountId);
  // A Shopify store or connected WordPress is edited directly; any other website gets a fix list.
  const access = await siteFor(accountId);
  if (!access) return { run: null, message: "Connect your website first." };
  const store = access.store;
  const brand = profile.brandName ?? (access.mode === "manual" ? null : await access.name().catch(() => null));
  // The writer signs titles with the customer's own brand and fits what they sell.
  const ai = { ...baseAi, site: siteBrief({ ...profile, brandName: brand }) };
  const ctx: Ctx = {
    accountId,
    site: access,
    store,
    ai,
    platform,
    // Search Console's property, or (without it) the site's own domain.
    ourDomain: conn.gscSiteUrl
      ? new URL(conn.gscSiteUrl.replace(/^sc-domain:/, "https://")).hostname.replace(/^www\./, "")
      : (profile.siteDomain ?? ""),
    allowContent: acct.allowContent,
    maxPagesPerWeek: acct.maxPagesPerWeek,
    preview: trigger === "preview",
    ownerApproves: owner,
  };
  const preview = trigger === "preview";

  // One run at a time per site, taken in a single statement so two runs starting together can't both go ahead
  // (and write the same article twice). A lock left by a run that crashed lapses after 30 minutes.
  const lock = `autopilot_running:${accountId}`;
  if (!preview) {
    const got = await sql`INSERT INTO insights_settings (key, value) VALUES (${lock}, ${String(Date.now())})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE insights_settings.updated_at < now() - interval '30 minutes'
      RETURNING key`;
    if (!got.length) return { run: null, message: "A run is already in progress." };
  }

  const [runRow] = await sql`INSERT INTO insights_autopilot_runs (account_id, trigger) VALUES (${accountId}, ${trigger}) RETURNING id`;
  if (!preview) await sql`UPDATE insights_account_autopilot SET last_run_at = now() WHERE account_id = ${accountId}`;
  const runId = runRow.id!;
  const summary: string[] = [];
  const notes: string[] = [];
  let status = "done";
  let changed = false;
  let previewOut: AutopilotPreview | undefined;
  try {
    // No verdicts while this site's clicks have just fallen sharply (a site problem or penalty, not the change).
    // Google updates don't stop measuring: changes measured across one are never undone and are kept apart.
    const traffic = await trafficCheck(conn).catch(() => null);
    const hold = traffic?.sharp ? `Google clicks fell ${Math.round(traffic.drop * 100)}% last week, so changes aren't judged until that settles.` : null;
    if (hold && !preview) summary.push(`Measuring waits: ${hold}`);
    if (!preview && !hold) {
      const measured = await measureOlderChanges(ctx, conn);
      summary.push(...measured.notes);
      // A change that hurt and is still live is a failure the Inspector must see.
      if (measured.undoFailures) status = "failed";
    }
    if (!preview && !hold) await measureControls(ctx, conn).catch((e) => console.error(`controls not measured: ${(e as Error).message}`));

    const [{ pages }] = await sql`
      SELECT count(DISTINCT page_url) AS pages FROM insights_autopilot_changes
      WHERE account_id = ${accountId} AND status IN ('applied', 'kept', 'suggested') AND field NOT IN ('internal_link', 'link_fix', 'prune')
        AND created_at > now() - interval '7 days'`;
    const capped = Number(pages) >= ctx.maxPagesPerWeek;
    // The weekly limit keeps the site steady, but it shouldn't block a rescue: a couple of urgent fixes may go over it.
    const urgentRoom = capped && Number(pages) < ctx.maxPagesPerWeek + URGENT_EXTRA;
    const indexRoom = capped && !urgentRoom && Number(pages) < ctx.maxPagesPerWeek + URGENT_EXTRA + INDEX_EXTRA;
    // Emergency brake: when Google clicks suddenly fall, change nothing new until it's clear why.
    const brake = traffic?.sharp
      ? `Google clicks fell ${Math.round(traffic.drop * 100)}% last week (${traffic.recentWeek} against a usual ${traffic.usualWeek}). New changes are on hold until that settles; check Search Console for a Google update or a site problem.`
      : null;
    // A new article for a chosen search no page covers yet (within the weekly number).
    if (!preview && !capped && !brake) {
      const posted = await nextNewArticle({
        accountId,
        site: access,
        ai,
        platform,
        ourDomain: ctx.ourDomain,
        // Waiting for the owner: saved as a draft they publish themselves.
        publish: acct.allowContent && !owner,
        perWeek: acct.articlesPerWeek,
      }).catch((e) => (summary.push(`New article not written: ${(e as Error).message}`), null));
      if (posted) {
        await logChange({
          accountId,
          runId,
          pageUrl: posted.url ?? `https://${ctx.ourDomain}/`,
          resourceType: posted.resourceType,
          resourceId: posted.resourceId,
          query: posted.keyword,
          field: "new_article",
          before: null,
          after: `<h1>${posted.article.title}</h1>\n<p><strong>SEO title:</strong> ${posted.article.metaTitle}<br><strong>Meta description:</strong> ${posted.article.metaDescription}</p>\n${posted.article.html}`,
          reason: `No page on the site covered "${posted.keyword}", so the autopilot wrote one from what ranks on Google page one.`,
          status: posted.resourceType === "site" ? "suggested" : "applied",
          note:
            posted.note ||
            (posted.live ? "Published." : owner ? "Saved as a draft for your approval: no second AI checked it, so read it and publish it in your store when it reads right." : "Saved as a draft: turn on new content in Autopilot settings to publish automatically."),
        });
        if (posted.live) changed = true;
        summary.push(
          posted.url
            ? `${posted.live ? "Published" : "Drafted"} a new article for "${posted.keyword}": ${posted.url}`
            : `Wrote a new article for "${posted.keyword}" (on the fix list).`
        );
        if (posted.problem) summary.push(posted.problem);
      }
    }
    if (capped && !preview && !urgentRoom && !indexRoom) {
      summary.push(`Weekly limit reached: ${pages} pages changed this week (limit ${ctx.maxPagesPerWeek}, plus up to ${URGENT_EXTRA} urgent fixes and ${INDEX_EXTRA} for pages missing from Google).`);
    } else if (brake && !preview) {
      summary.push(brake);
    } else {
      if (capped) notes.push(`The weekly limit is reached (${pages} of ${ctx.maxPagesPerWeek} pages), so a real run would wait.`);
      if (brake) notes.push(`${brake} A real run would wait.`);
      const recordGap = preview
        ? null
        : (cand: Candidate, page: StoreResource, idea: string) =>
            logChange({
              accountId,
              runId,
              pageUrl: cand.op.page,
              resourceType: page.type,
              resourceId: page.id,
              query: cand.op.query,
              field: "intent",
              before: null,
              after: idea,
              reason: "Searchers want something this page can't honestly offer yet, so the autopilot left it unchanged.",
              status: "skipped",
              op: cand.op,
            }).then(() => undefined);
      if (capped && !preview) {
        ctx.urgentOnly = true;
        ctx.indexOnly = !urgentRoom;
      }
      const plan = await planNextChange(ctx, conn, notes, recordGap);
      const gaps = notes.filter((n) => n.startsWith("Skipped “"));
      if (!plan && ctx.urgentOnly) {
        // Say why, so the Inspector (and the owner) can see an urgent fix that keeps getting stuck.
        const why = notes.filter((x) => /^(Urgent check|Skipped “|Left )/.test(x)).join(" ");
        const none = notes.some((x) => /^Urgent check: 0 urgent/.test(x));
        const cap = `Weekly limit reached: ${pages} pages changed this week (limit ${ctx.maxPagesPerWeek}, plus up to ${URGENT_EXTRA} urgent fixes and ${INDEX_EXTRA} for pages missing from Google)`;
        // Nothing urgent to do is a normal paced week; an urgent fix that couldn't be made is worth the Inspector's eye.
        summary.push(none ? `${cap}. Nothing urgent to fix.` : `${cap}, and no urgent fix could be made.${why ? ` ${why}` : ""}`);
      } else if (!plan) {
        summary.push(gaps.length ? `No change made. ${gaps.join(" ")}` : "No new opportunities to work on right now.");
      } else if (preview) {
        const { cand, page, improvement } = plan;
        const changes: AutopilotPreview["changes"] = [];
        if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) changes.push({ field: "meta_title", before: page.metaTitle, after: improvement.metaTitle });
        if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription)
          changes.push({ field: "meta_description", before: page.metaDescription, after: improvement.metaDescription });
        for (const a of improvement.altTexts) changes.push({ field: "alt", before: null, after: a.alt });
        if (improvement.contentSectionHtml && (page.type === "article" || page.type === "page"))
          changes.push({ field: "content", before: null, after: improvement.contentSectionHtml });
        if (page.type === "article" || page.type === "page") {
          const body = improvement.contentSectionHtml ? `${page.body}\n${improvement.contentSectionHtml}` : page.body;
          const schema = await schemaFor(ctx, { ...page, metaDescription: improvement.metaDescription || page.metaDescription }, body).catch(() => null);
          if (schema) {
            const types = [...schema.matchAll(/"@type":"(BlogPosting|FAQPage)"/g)].map((m) => m[1]).join(" and ");
            changes.push({ field: "schema", before: null, after: `Adds ${types} structured data built from the page.` });
          }
        }
        const source = cand.inferred ? undefined : await linkSource(ctx, cand, page).catch(() => undefined);
        if (source) changes.push({ field: "internal_link", before: null, after: `A closing paragraph in “${source.title}” linking here.` });
        previewOut = {
          page: cand.op.page,
          query: cand.op.query,
          mode: cand.mode,
          position: cand.op.position,
          monthlySearches: cand.op.monthlySearches ?? null,
          apps: plan.apps,
          changes,
          reason: improvement.reason,
          notes: [...plan.summaries, ...notes],
        };
        summary.push(`Preview: ${describe(cand).replace(/^(Defended|Pushed|Improved)/, (w) => `would have ${w.toLowerCase()}`)}. ${changes.length} change${changes.length === 1 ? "" : "s"} planned, nothing written.`);
      } else {
        const done = await applyPlan(ctx, runId, plan);
        // Held for the owner's approval: nothing changed on the site yet, so no recrawl and no control.
        if (done.length && ctx.site.writer && !owner) changed = true;
        // Hold a similar page untouched as this change's control.
        if (done.length && ctx.site.writer && !owner && plan.control) {
          const c = plan.control.op;
          // Only beside a change really made on the site (not one only suggested).
          await sql`INSERT INTO insights_autopilot_controls (account_id, run_id, page_url, query, baseline_position, baseline_clicks)
            SELECT ${accountId}, ${runId}, ${c.page}, ${c.query}, ${c.position}, ${c.clicks ?? null}
            WHERE EXISTS (SELECT 1 FROM insights_autopilot_changes WHERE run_id = ${runId} AND status = 'applied')`.catch((e) =>
            console.error(`control not recorded: ${(e as Error).message}`)
          );
        }
        const reviewed = notes.filter((n) => n.includes("The reviewing AI turned down"));
        const told = [...plan.summaries, ...gaps, ...reviewed];
        const extra = told.length ? ` ${told.join(" ")}` : "";
        summary.push(
          done.length
            ? `${describe(plan.cand)}: ${done.join(", ").replace(/_/g, " ")}.${extra}`
            : `Checked ${new URL(plan.cand.op.page).pathname}; it already looked good, nothing changed.${extra}`
        );
      }
    }
  } catch (err) {
    status = "failed";
    summary.push((err as Error).message);
  }
  // Pages changed on the site: tell Google now instead of waiting for its next visit.
  // Counted from what this run really changed on the site, not from suggestions.
  const [{ n: appliedNow }] = changed && !preview
    ? await sql`SELECT count(*) AS n FROM insights_autopilot_changes WHERE run_id = ${runId} AND status = 'applied'`.catch(() => [{ n: 0 }])
    : [{ n: 0 }];
  if (Number(appliedNow) > 0) {
    // A reviewed article this run changed loses its Reviewed by line right away, not at the next check.
    await expireReviews(accountId).catch((e) => console.error(`reviews not checked: ${(e as Error).message}`));
    const said = await askGoogleToRecrawl(conn).catch(() => null);
    if (said) summary.push(said);
  }
  // Each new article gets social posts and a short video script for the owner to share (one per run, checked by a second AI).
  if (!preview && status !== "failed") {
    const shared = await makeNextShareKit(accountId, ai, brand, ctx.ourDomain).catch((e) => `Social posts not written yet: ${(e as Error).message}`);
    if (shared) summary.push(shared);
  }
  const [run] = await sql`
    UPDATE insights_autopilot_runs SET finished_at = now(), status = ${status}, summary = ${summary.join(" ")}
    WHERE id = ${runId} RETURNING *`;
  if (!preview) await sql`DELETE FROM insights_settings WHERE key = ${lock}`.catch((e) => console.error(`run lock not released: ${(e as Error).message}`));
  return { run: toRun(run), message: summary.join(" "), preview: previewOut };
}

/** Accounts due for their daily run (enabled, store connected, not run in the last 20 hours). */
export async function accountsDueForRun(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_account_profile p ON p.account_id = a.account_id
    LEFT JOIN LATERAL (SELECT r.status, r.summary FROM insights_autopilot_runs r WHERE r.account_id = a.account_id AND r.trigger <> 'preview' ORDER BY r.started_at DESC LIMIT 1) lr ON true
    WHERE a.enabled AND (a.shop_token_enc IS NOT NULL OR p.site_domain IS NOT NULL)
      AND (a.last_run_at IS NULL OR a.last_run_at < now() - interval '20 hours' OR ((lr.status = 'failed' AND lr.summary ~* 'busy|high demand|answer was empty|overloaded|fetch failed' AND lr.summary !~* 'limit for the month|accept the key') AND a.last_run_at < now() - interval '3 hours'))
      -- A site that has never run is retried every 2 hours, so fixing its setup gets it going soon.
      -- A run that failed only because an AI service was busy is tried again after 3 hours instead of the next day.
      AND (a.run_tried_at IS NULL OR a.run_tried_at < now() - CASE WHEN a.last_run_at IS NULL THEN interval '2 hours' WHEN (lr.status = 'failed' AND lr.summary ~* 'busy|high demand|answer was empty|overloaded|fetch failed' AND lr.summary !~* 'limit for the month|accept the key') THEN interval '3 hours' ELSE interval '20 hours' END)
    ORDER BY a.run_tried_at NULLS FIRST, a.last_run_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => r.account_id!);
}

/** Enabled sites whose last inspection is oldest, so every site is inspected regularly, not only those worked this hour. */
export async function accountsDueForInspection(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT account_id FROM insights_account_autopilot
    WHERE enabled AND (inspected_at IS NULL OR inspected_at < now() - interval '6 hours')
    ORDER BY inspected_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => r.account_id!);
}

// ---------- undo ----------

/** True when the live title or description is no longer what the autopilot wrote (the owner changed it since). */
export function ownerChangedSeo(live: string | null | undefined, written: string | null): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
  return norm(live) !== norm(written);
}

/**
 * Undoes one change. With `checkLive` (the autopilot's own undo), a title or description the owner has changed
 * since is left as the owner made it, never overwritten. An undo by hand does what the owner asked.
 */
async function revertRow(ctx: Ctx, c: Row, opts: { checkLive?: boolean } = {}): Promise<string> {
  const field = c.field as ChangeField;
  const w = ctx.site?.writer;
  if (c.resource_type === "snippet") {
    // The snippet only serves live changes, so marking it undone removes it from the site.
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted', reverted_at = now() WHERE id = ${c.id}`;
    return "Removed from your site (the snippet stops showing it right away).";
  }
  if (c.resource_type === "site" || !w) {
    // A change pasted in by hand is changed back by hand.
    const back = c.before_value && field !== "content" && field !== "schema" && field !== "internal_link" ? `put back: ${c.before_value}` : "remove what was added";
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted', reverted_at = now() WHERE id = ${c.id}`;
    return `This one didn't help; ${back}.`;
  }
  if (field === "prune") {
    // Undo a take down: publish the article again.
    if (ctx.site?.mode !== "shopify" || !ctx.site.store) throw new Error("Only Shopify articles are taken down automatically.");
    await setArticlePublished(ctx.site.store, c.resource_id!, true);
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted', reverted_at = now() WHERE id = ${c.id}`;
    await restoreTarget(ctx.accountId, c.page_url!).catch(() => undefined);
    return "Published again.";
  }
  if (field === "new_article") {
    await unpublishArticle(ctx.accountId, ctx.site, c.resource_id!);
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted', reverted_at = now() WHERE id = ${c.id}`;
    // Its search no longer has a live page, and pillars written from now on won't link to it
    // (a pillar already published keeps its link until the owner edits it).
    const t = (await readTargets(ctx.accountId).catch(() => [])).find((x) => x.keyword === c.query);
    if (t) await saveTarget(ctx.accountId, { ...t, page: null, article: t.article ? { ...t.article, live: false, note: "Taken down (undo)" } : t.article });
    return "Taken off the site (kept as a draft).";
  }
  if (field === "meta_title" || field === "meta_description") {
    if (opts.checkLive) {
      // A read that fails throws, so the undo waits for the next run rather than writing blind.
      const live = await ctx.site.resolve(c.page_url!);
      // The page is gone (deleted or moved by the owner): nothing to undo, and retrying would fail every day.
      if (!live) {
        await sql`UPDATE insights_autopilot_changes SET status = 'kept', note = ${"The page is no longer on the site, so there was nothing to undo."} WHERE id = ${c.id}`;
        return "Nothing to undo: the page is gone.";
      }
      if (live.id === c.resource_id) {
        const now = field === "meta_title" ? live.metaTitle : live.metaDescription;
        if (ownerChangedSeo(now, c.after_value)) {
          const note = `The ${field === "meta_title" ? "title" : "description"} was changed on the site after this change, so the owner's version was kept. Owner's version: ${String(now ?? "").slice(0, 200)}`;
          await sql`UPDATE insights_autopilot_changes SET status = 'kept', note = ${note} WHERE id = ${c.id}`;
          return "Kept: the owner changed it since.";
        }
      }
    }
    await w.setSeo(c.resource_id!, field === "meta_title" ? "title" : "description", c.before_value).catch((e) => {
      if ((e as Error).name !== "SavedNotLive") throw e;
    });
  } else if (field === "alt") {
    await w.setAlt?.(c.target_id!, c.before_value ?? "");
  } else if (field === "link_fix") {
    if (!ctx.store || !(await undoLinkFix(ctx.store, c.resource_type as "article" | "page", c.resource_id!, c.before_value!, c.after_value!))) {
      await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'The post was edited after the fix, so it was left as is.' WHERE id = ${c.id}`;
      return "Left as is.";
    }
  } else if (field === "schema" && w.setSchema) {
    // A new schema block replaced the one before it: undoing it puts that one back.
    const prev = await previousSchema(c);
    await w.setSchema(c.resource_type as "article" | "page", c.resource_id!, prev);
  } else {
    const type = field === "internal_link" ? "article" : (c.resource_type as "article" | "page");
    const id = field === "internal_link" ? c.target_id! : c.resource_id!;
    const body = await w.getBody(type, id);
    const restored = unwrap(c.before_value!, body);
    if (restored === null) {
      await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'The added section was already removed or edited by hand.' WHERE id = ${c.id}`;
      return "Already removed.";
    }
    const prev = field === "schema" ? await previousSchema(c) : null;
    await w.setBody(type, id, prev ? `${withoutAutopilotSchema(restored)}\n${prev}` : restored);
  }
  await sql`UPDATE insights_autopilot_changes SET status = 'reverted', reverted_at = now() WHERE id = ${c.id}`;
  return "Restored the previous version.";
}

/** The schema block a newer one replaced on the same page (the last earlier one still live), or null. */
async function previousSchema(c: Row): Promise<string | null> {
  const [p] = await sql`SELECT after_value FROM insights_autopilot_changes
    WHERE account_id = ${c.account_id} AND resource_type = ${c.resource_type} AND resource_id = ${c.resource_id} AND field = 'schema'
      AND status IN ('applied', 'kept') AND id < ${c.id} AND after_value IS NOT NULL
    ORDER BY id DESC LIMIT 1`;
  return p?.after_value ?? null;
}

/** The owner pasted a fix list item in (it's measured from now on) or skipped it. */
export async function markSuggestion(accountId: string, id: string, done: boolean): Promise<void> {
  await ensureSchema();
  const rows = done
    ? // A take down done by hand has nothing left to measure, so it's kept rather than waiting for measurement.
      await sql`UPDATE insights_autopilot_changes SET status = CASE WHEN field = 'prune' THEN 'kept' ELSE 'applied' END, created_at = now(), note = 'Done by hand.'
        WHERE id = ${id} AND account_id = ${accountId} AND status = 'suggested' RETURNING id`
    : await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'Skipped.'
        WHERE id = ${id} AND account_id = ${accountId} AND status = 'suggested' RETURNING id`;
  if (!rows.length) throw new Error("That fix isn't waiting anymore.");
}

export async function revertChange(accountId: string, id: string): Promise<void> {
  await ensureSchema();
  const [c] = await sql`SELECT * FROM insights_autopilot_changes WHERE id = ${id} AND account_id = ${accountId}`;
  if (!c) throw new Error("That change doesn't exist.");
  if (c.status !== "applied" && c.status !== "kept") throw new Error("Only live changes can be undone.");
  const site = await siteFor(accountId);
  if (!site?.writer && c.resource_type !== "site" && c.resource_type !== "snippet") throw new Error("Reconnect your store or website first.");
  const ctx = { accountId, site, store: site?.store ?? null } as Ctx;
  const note = await revertRow(ctx, c);
  await sql`UPDATE insights_autopilot_changes SET note = ${`Undone by hand. ${note}`} WHERE id = ${id} AND status = 'reverted'`;
}

// ---------- reading ----------

const num = (v: string | null) => (v === null ? null : Number(v));

function toRun(r: Row): AutopilotRun {
  return { id: r.id!, startedAt: r.started_at!, finishedAt: r.finished_at, trigger: r.trigger!, status: r.status!, summary: r.summary };
}

export async function autopilotHistory(accountId: string): Promise<{ changes: AutopilotChange[]; runs: AutopilotRun[] }> {
  await ensureSchema();
  const changes = await sql`SELECT * FROM insights_autopilot_changes WHERE account_id = ${accountId} ORDER BY id DESC LIMIT 100`;
  const runs = await sql`SELECT * FROM insights_autopilot_runs WHERE account_id = ${accountId} ORDER BY id DESC LIMIT 10`;
  return {
    changes: changes.map((c) => ({
      id: c.id!,
      createdAt: c.created_at!,
      pageUrl: c.page_url!,
      query: c.query!,
      field: c.field as ChangeField,
      before: c.field === "content" || c.field === "internal_link" || c.field === "link_fix" ? null : c.before_value,
      after: c.field === "link_fix" ? c.reason : (c.after_value?.replace(/<!--[\s\S]*?-->/g, "") ?? null),
      reason: c.reason,
      status: c.status as AutopilotChange["status"],
      baselinePosition: num(c.baseline_position),
      resultPosition: num(c.result_position),
      evaluatedAt: c.evaluated_at,
      note: c.note,
      targetId: c.target_id,
      awaiting: c.status === "suggested" && c.resource_type !== "site",
    })),
    runs: runs.map(toRun),
  };
}

// ---------- Index rescue ----------

/** A page Google crawled and left out gets one substantial new section, at most once a month. */
const RESCUE_EVERY_DAYS = 30;
/** Waits this long after any change to the page, so Google has seen the last one first. */
const RESCUE_AFTER_DAYS = 7;

/** Sites with autopilot on and content allowed whose index rescue is due (weekly). */
export async function accountsDueForRescue(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'index_rescue_at:' || a.account_id
    LEFT JOIN insights_settings q ON q.key = 'rescue_queue:' || a.account_id
    WHERE a.enabled AND coalesce(a.allow_content, true) AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days'
      OR (q.value IS NOT NULL AND q.value <> '[]' AND q.updated_at > s.updated_at))
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export async function markRescueTried(accountId: string, note: string): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`index_rescue_at:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), note })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * The Index rescue: a page Google crawled but chose not to index (thin or too similar) gets one substantial new
 * section, written and checked like every other change (facts, human edit, claim guard, second AI, duplicate guard).
 * Only the body changes, never the title or description, so it can't collide with another change being measured;
 * it is logged outside the autopilot runs (no run), so the ranking measure leaves it alone, and the owner can undo it.
 * Success is Google putting the page in its index, which the health check sees on its next pass.
 */
export async function rescueUnindexed(accountId: string, conn: Connection | null): Promise<string> {
  await ensureSchema();
  const [acct, platform] = await Promise.all([readAccountAutopilot(accountId), readPlatformSettings()]);
  if (!acct.enabled || !acct.allowContent) return "new content is off for this site";
  const baseAi = aiProvider(platform);
  if (!baseAi) throw new Error("No AI key is set up.");
  const access = await siteFor(accountId);
  if (!access?.writer) return "this site can't be edited by the app";
  const rows = await rescuable(accountId);
  if (!rows.length) return "no page waiting to be rescued";
  // Pages the Strategist sent go first.
  const [qrow] = await sql`SELECT value FROM insights_settings WHERE key = ${`rescue_queue:${accountId}`}`.catch(() => [] as { value: string | null }[]);
  const queue = qrow?.value ? (JSON.parse(qrow.value) as string[]) : [];
  const at = (u: string) => (queue.includes(u) ? queue.indexOf(u) : 99);
  rows.sort((a, b) => at(a) - at(b));
  rows.splice(3);
  // One autopilot change at a time per site.
  const lock = `autopilot_running:${accountId}`;
  const got = await sql`INSERT INTO insights_settings (key, value) VALUES (${lock}, ${String(Date.now())})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE insights_settings.updated_at < now() - interval '30 minutes'
    RETURNING key`;
  if (!got.length) return "no page waiting to be rescued: an autopilot run is in progress, so it's tried again next hour";
  // Tried: the queued pages leave the queue only now (whatever the outcome, they were worked on).
  const tried = new Set(rows);
  const doneQueue = () =>
    queue.length
      ? sql`UPDATE insights_settings SET value = ${JSON.stringify(queue.filter((u) => !tried.has(u)))} WHERE key = ${`rescue_queue:${accountId}`}`.catch(() => undefined)
      : Promise.resolve(undefined);
  try {
    return await rescueSome(accountId, conn, rows, access, baseAi, platform, acct.maxPagesPerWeek);
  } finally {
    await doneQueue();
    await sql`DELETE FROM insights_settings WHERE key = ${lock}`.catch(() => undefined);
  }
}

/** Pages Google crawled but left out, ready for a rescue: not changed in 7 days, no new section in 30, not a control page. */
export async function rescuable(accountId: string): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT h.url FROM insights_page_health h
    WHERE h.account_id = ${accountId}
      -- A second look: Google's answer must be fresh (checked in the last 8 days), so a page Google has since taken
      -- in is never rewritten.
      AND h.checked_at > now() - interval '8 days'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(h.issues) i WHERE i->>'text' ~* '^Not in Google: .*(crawled|discovered)')
      AND NOT EXISTS (SELECT 1 FROM insights_autopilot_changes c WHERE c.account_id = ${accountId} AND c.page_url = h.url
        AND c.status IN ('applied', 'kept', 'suggested')
        AND (c.created_at > now() - make_interval(days => ${RESCUE_AFTER_DAYS})
          OR (c.field = 'content' AND c.created_at > now() - make_interval(days => ${RESCUE_EVERY_DAYS}))))
      AND NOT EXISTS (SELECT 1 FROM insights_autopilot_controls k WHERE k.account_id = ${accountId} AND k.page_url = h.url AND k.evaluated_at IS NULL)
    ORDER BY h.checked_at DESC LIMIT 20`;
  return rows.map((r) => String(r.url));
}

/** Writes a rescue section for the first of these pages that passes every check. The caller holds the site's run lock. */
async function rescueSome(
  accountId: string,
  conn: Connection | null,
  rows: string[],
  access: SiteAccess,
  baseAi: AiProvider,
  platform: PlatformSettings,
  maxPagesPerWeek: number,
): Promise<string> {
  const writer = access.writer!;
  {
    const acct = { maxPagesPerWeek };
    const profile = await readProfile(accountId);
    const brand = profile.brandName ?? (await access.name().catch(() => null));
    const ai = { ...baseAi, site: siteBrief({ ...profile, brandName: brand }) };
    const ctx: Ctx = {
      accountId,
      site: access,
      store: access.store,
      ai,
      platform,
      ourDomain: conn?.gscSiteUrl ? new URL(conn.gscSiteUrl.replace(/^sc-domain:/, "https://")).hostname.replace(/^www\./, "") : (profile.siteDomain ?? ""),
      allowContent: true,
      maxPagesPerWeek: acct.maxPagesPerWeek,
    };
    const [kws, targets] = await Promise.all([
      import("./site-keywords").then((m) => m.readSiteKeywords(accountId)).catch(() => []),
      readTargets(accountId).catch(() => []),
    ]);
    for (const url of rows) {
      const page = await access.resolve(url).catch(() => null);
      if (!page || (page.type !== "article" && page.type !== "page")) continue;
      if (writer.supports && !(await writer.supports("content", page.id).catch(() => false))) continue;
      const query =
        targets.find((t) => t.page === url && t.role !== "support")?.keyword ??
        kws.find((k) => k.page === url && k.role !== "support")?.keyword ??
        page.title;
      const imp = await ownerApproves(ai, () => writeImprovement(ai, page, { query, position: 0, impressions: 0, mode: "climb" }, [], true, true));
      // A section the writer itself says misses what searchers want is never added (and it skipped the second AI's check).
      if (!imp.intentMatch) continue;
      // Only the new section is used; the guard drops anything that repeats this or another page.
      const guarded = await guardDuplicates(ctx, page, { ...imp, metaTitle: page.metaTitle ?? "", metaDescription: page.metaDescription ?? "" }, []);
      const section = guarded.contentSectionHtml;
      if (!section) continue;
      const blockId = `rescue-${Date.now()}-content`;
      const block = wrap(blockId, section);
      const reason = "Index rescue: Google crawled this page but left it out of its index, so a substantial new section was added to make it more useful and distinct.";
      // With the owner as the check, the section waits for their approval instead of going live.
      if (!hasSecondAi(baseAi)) {
        await replaceWaiting(accountId, url, "content");
        await logChange({
          accountId,
          runId: null,
          pageUrl: url,
          resourceType: access.mode === "snippet" ? "snippet" : page.type,
          resourceId: page.id,
          query,
          field: "content",
          before: blockId,
          after: block,
          reason,
          status: "suggested",
          note: OWNER_APPROVAL,
        });
        return `wrote a new section for ${new URL(url).pathname}, waiting for your approval`;
      }
      try {
        await writer.setBodyIfUnchanged(page.type, page.id, page.body, `${page.body}\n${block}`);
      } catch (err) {
        // The owner edited the page meanwhile: their edit wins; the next page is tried.
        if (err instanceof EditedMeanwhile || (err as Error).name === "UnpublishedDraft") continue;
        throw err;
      }
      await logChange({
        accountId,
        runId: null,
        pageUrl: url,
        resourceType: access.mode === "snippet" ? "snippet" : page.type,
        resourceId: page.id,
        query,
        field: "content",
        before: blockId,
        after: block,
        reason: "Index rescue: Google crawled this page but left it out of its index, so a substantial new section was added to make it more useful and distinct.",
        status: "applied",
      });
      if (conn) await askGoogleToRecrawl(conn).catch(() => null);
      return `added a new section to ${new URL(url).pathname} so Google indexes it`;
    }
    return "no rescue section passed the checks";
  }
}
