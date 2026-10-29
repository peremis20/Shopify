import type { Connection } from "../connection";
import { ensureSchema, sql, type Row } from "../db";
import { resolveRange } from "../dates";
import { googleRequest } from "../google-auth";
import { findOpportunities } from "../seo-tools";
import type { Opportunity } from "../seo-types";
import { clickGain, relatedPhrases, withVolumes, type BoostedOpportunity } from "./keyword-boost";
import { analyzeCompetition, type Competition } from "./serp";
import { pageValues, topPositionSignals, valueWeight, type PageValue } from "./signals";
import { aiProvider, readAccountAutopilot, readPlatformSettings, type AiProvider } from "./settings";
import {
  getBody,
  listArticles,
  resolveResource,
  setBody,
  setImageAlt,
  setSeoField,
  type StoreAccess,
  type StoreResource,
} from "./shopify";
import type { AutopilotChange, AutopilotRun, ChangeField } from "./types";
import { writeImprovement, writeInternalLink } from "./writer";

/**
 * The SEO autopilot. Each run: measure older changes and undo the ones that
 * hurt, then improve one page (titles, descriptions, alt text, a new
 * section, an internal link), within the weekly page limit.
 *
 * Which page, in order:
 * 1. Defend: a page one search that is slipping (Search Console, last 7 days vs the 4 weeks before).
 * 2. Attack: the biggest gain among #2 to #3 searches going for #1, and #4 to #20 going for the top 3,
 *    sized by Keyword Planner search volume and weighted by how well the page converts (GA4).
 * The writer sees who holds page one for the search and what those pages cover.
 */

const MEASURE_AFTER_DAYS = 28;
const REST_DAYS_PER_PAGE = 45;
/** A slipping page can be defended again sooner, once the last change has had time to count. */
const DEFEND_REST_DAYS = 21;
const WORSE_BY_POSITIONS = 3;

/** Everything a run needs for one customer. */
interface Ctx {
  accountId: string;
  store: StoreAccess;
  ai: AiProvider;
  /** Search results API key; competitor analysis is skipped without it. */
  serpKey?: string;
  ourDomain: string;
  allowContent: boolean;
  maxPagesPerWeek: number;
}

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

async function logChange(c: {
  accountId: string;
  runId: string;
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

const words = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

// ---------- measuring ----------

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
  return body.rows?.[0] ?? null;
}

/** Looks at pages changed at least 4 weeks ago; keeps what helped and undoes what hurt. */
async function measureOlderChanges(ctx: Ctx, conn: Connection): Promise<string[]> {
  const due = await sql`
    SELECT run_id, page_url, query, min(baseline_position) AS baseline_position, min(baseline_clicks) AS baseline_clicks
    FROM insights_autopilot_changes
    WHERE account_id = ${ctx.accountId} AND status = 'applied' AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})
    GROUP BY run_id, page_url, query
    LIMIT 5`;
  const notes: string[] = [];
  for (const d of due) {
    const now = await positionFor(conn, d.query!, d.page_url!).catch(() => null);
    const baseline = Number(d.baseline_position);
    const baseClicks = Number(d.baseline_clicks ?? 0);
    const worse = now ? now.position > baseline + WORSE_BY_POSITIONS && now.clicks <= baseClicks : false;
    const changes = await sql`
      SELECT * FROM insights_autopilot_changes
      WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND status = 'applied' ORDER BY id DESC`;
    for (const c of changes) {
      if (worse) {
        const note = await revertRow(ctx, c).catch((e) => `Undo failed: ${e.message}`);
        await sql`UPDATE insights_autopilot_changes SET evaluated_at = now(), result_position = ${now!.position}, result_clicks = ${now!.clicks},
          note = ${`Ranking dropped from ${baseline.toFixed(1)} to ${now!.position.toFixed(1)}. ${note}`} WHERE id = ${c.id}`;
      } else {
        await sql`UPDATE insights_autopilot_changes SET status = 'kept', evaluated_at = now(),
          result_position = ${now?.position ?? null}, result_clicks = ${now?.clicks ?? null},
          note = ${now ? `Position ${baseline.toFixed(1)} → ${now.position.toFixed(1)}` : "Not enough search data yet to compare; kept."} WHERE id = ${c.id}`;
      }
    }
    notes.push(`${worse ? "Undid" : "Kept"} changes for “${d.query}”`);
  }
  return notes;
}

// ---------- improving ----------

type Mode = "defend" | "top" | "climb";

interface Candidate {
  op: BoostedOpportunity;
  mode: Mode;
  previousPosition?: number;
}

function pickTarget(
  cands: Candidate[],
  all: Opportunity[],
  brand: string,
  rested: (c: Candidate) => boolean
): { cand: Candidate; related: string[] } | null {
  const cand = cands.find((c) => {
    const path = new URL(c.op.page).pathname;
    return !(brand && c.op.query.includes(brand)) && !rested(c) && /^\/(blogs\/[^/]+\/[^/]+|pages|products|collections)\//.test(path + "/");
  });
  if (!cand) return null;
  const related = [...new Set(all.filter((o) => o.page === cand.op.page && o.query !== cand.op.query).map((o) => o.query))];
  return { cand, related };
}

async function improvePage(
  ctx: Ctx,
  runId: string,
  cand: Candidate,
  related: string[],
  page: StoreResource,
  value: PageValue | undefined,
  competition: Competition | null
) {
  const { op } = cand;
  const done: string[] = [];
  const phrases = await relatedPhrases(op.query, op.page);
  const plan = await writeImprovement(ctx.ai, page, op, related, ctx.allowContent, phrases, {
    mode: cand.mode,
    previousPosition: cand.previousPosition,
    value,
    competition,
  });
  const base = { accountId: ctx.accountId, runId, pageUrl: op.page, resourceType: page.type, resourceId: page.id, query: op.query, reason: plan.reason, op };

  const apply = async (field: ChangeField, before: string | null, after: string, run: () => Promise<void>, targetId?: string) => {
    try {
      await run();
      await logChange({ ...base, field, before, after, status: "applied", targetId });
      done.push(field);
    } catch (err) {
      await logChange({ ...base, field, before, after, status: "failed", targetId, note: (err as Error).message });
    }
  };

  if (plan.metaTitle && plan.metaTitle !== page.metaTitle) {
    await apply("meta_title", page.metaTitle, plan.metaTitle, () => setSeoField(ctx.store, page.id, "title_tag", plan.metaTitle));
  }
  if (plan.metaDescription && plan.metaDescription !== page.metaDescription) {
    await apply("meta_description", page.metaDescription, plan.metaDescription, () =>
      setSeoField(ctx.store, page.id, "description_tag", plan.metaDescription)
    );
  }
  for (const a of plan.altTexts) {
    await apply("alt", null, a.alt, () => setImageAlt(ctx.store, a.imageId, a.alt), a.imageId);
  }
  if (plan.contentSectionHtml && (page.type === "article" || page.type === "page")) {
    const blockId = `${runId}-content`;
    const block = wrap(blockId, plan.contentSectionHtml);
    await apply("content", blockId, block, () => setBody(ctx.store, page.type as "article" | "page", page.id, `${page.body}\n${block}`));
  }

  // One internal link from the most related other blog post that doesn't link here yet.
  const path = new URL(op.page).pathname;
  const topic = words(`${op.query} ${page.title}`);
  const source = (await listArticles(ctx.store))
    .filter((a) => a.url !== path && !a.body.includes(path))
    .map((a) => ({ a, score: [...words(a.title)].filter((w) => topic.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)[0]?.a;
  if (source) {
    const sentence = await writeInternalLink(ctx.ai, source, { path, query: op.query, title: page.title });
    if (sentence) {
      const blockId = `${runId}-link`;
      const block = wrap(blockId, sentence);
      await apply("internal_link", blockId, block, () => setBody(ctx.store, "article", source.id, `${source.body}\n${block}`), source.id);
    }
  }
  return done;
}

export interface RunResult {
  run: AutopilotRun | null;
  message: string;
}

/** One autopilot pass for one customer. Improves at most one page per call. */
export async function runAutopilot(accountId: string, conn: Connection | null, trigger: "schedule" | "manual"): Promise<RunResult> {
  await ensureSchema();
  const [acct, platform] = await Promise.all([readAccountAutopilot(accountId), readPlatformSettings()]);
  if (trigger === "schedule" && !acct.enabled) return { run: null, message: "Autopilot is turned off." };
  if (!conn?.gscSiteUrl) return { run: null, message: "Choose a Search Console property in Settings first." };
  const ai = aiProvider(platform);
  if (!ai) return { run: null, message: "Autopilot isn't available yet." };
  if (!acct.shopDomain || !acct.shopTokenEnc) return { run: null, message: "Connect your Shopify store first." };
  const ctx: Ctx = {
    accountId,
    store: { accountId, shopDomain: acct.shopDomain },
    ai,
    serpKey: platform.serperKey,
    ourDomain: new URL(conn.gscSiteUrl.replace(/^sc-domain:/, "https://")).hostname.replace(/^www\./, ""),
    allowContent: acct.allowContent,
    maxPagesPerWeek: acct.maxPagesPerWeek,
  };

  const running = await sql`SELECT id FROM insights_autopilot_runs
    WHERE account_id = ${accountId} AND status = 'running' AND started_at > now() - interval '30 minutes'`;
  if (running.length) return { run: null, message: "A run is already in progress." };

  const [runRow] = await sql`INSERT INTO insights_autopilot_runs (account_id, trigger) VALUES (${accountId}, ${trigger}) RETURNING id`;
  await sql`UPDATE insights_account_autopilot SET last_run_at = now() WHERE account_id = ${accountId}`;
  const runId = runRow.id!;
  const summary: string[] = [];
  let status = "done";
  try {
    summary.push(...(await measureOlderChanges(ctx, conn)));

    const [{ pages }] = await sql`
      SELECT count(DISTINCT page_url) AS pages FROM insights_autopilot_changes
      WHERE account_id = ${accountId} AND status IN ('applied', 'kept') AND field <> 'internal_link'
        AND created_at > now() - interval '7 days'`;
    if (Number(pages) >= ctx.maxPagesPerWeek) {
      summary.push(`Weekly limit reached (${pages} of ${ctx.maxPagesPerWeek} pages).`);
    } else {
      const changedSince = async (days: number) =>
        new Set(
          (await sql`SELECT DISTINCT page_url FROM insights_autopilot_changes
            WHERE account_id = ${accountId} AND created_at > now() - make_interval(days => ${days})`).map((r) => r.page_url!)
        );
      const [restedLong, restedShort] = await Promise.all([changedSince(REST_DAYS_PER_PAGE), changedSince(DEFEND_REST_DAYS)]);
      const skipped = new Set<string>();
      const rested = (c: Candidate) =>
        skipped.has(c.op.page) || (c.mode === "defend" ? restedShort : restedLong).has(c.op.page);
      const brand = ctx.ourDomain.split(".")[0];

      const [climb, signals, values] = await Promise.all([
        findOpportunities(conn, "28d"),
        topPositionSignals(conn).catch(() => ({ slipping: [], nearTop: [] })),
        pageValues(conn).catch(() => new Map<string, PageValue>()),
      ]);
      const valueOf = (o: Opportunity) => values.get(new URL(o.page).pathname);
      const [slipping, attack] = await Promise.all([
        withVolumes(signals.slipping),
        withVolumes([...signals.nearTop, ...climb]),
      ]);
      const nearTopKeys = new Set(signals.nearTop.map((o) => `${o.query}\n${o.page}`));
      const score = (o: BoostedOpportunity) => clickGain(o) * valueWeight(valueOf(o));
      const cands: Candidate[] = [
        ...slipping
          .sort((a, b) => score(b) - score(a))
          .map((op) => ({ op, mode: "defend" as const, previousPosition: signals.slipping.find((s) => s.query === op.query && s.page === op.page)?.previousPosition })),
        ...attack
          .sort((a, b) => score(b) - score(a))
          .map((op) => ({ op, mode: nearTopKeys.has(`${op.query}\n${op.page}`) ? ("top" as const) : ("climb" as const) })),
      ];
      const all = [...climb, ...signals.nearTop, ...signals.slipping];

      let picked = pickTarget(cands, all, brand, rested);
      let page: StoreResource | null = null;
      // Skip pages that don't map to an editable store item (up to a few tries).
      for (let tries = 0; picked && tries < 5; tries++) {
        page = await resolveResource(ctx.store, picked.cand.op.page).catch(() => null);
        if (page) break;
        skipped.add(picked.cand.op.page);
        picked = pickTarget(cands, all, brand, rested);
      }
      if (!picked || !page) {
        summary.push("No new opportunities to work on right now.");
      } else {
        const { cand } = picked;
        const competition = ctx.serpKey
          ? await analyzeCompetition(ctx.serpKey, accountId, cand.op.query, ctx.ourDomain).catch(() => null)
          : null;
        const done = await improvePage(ctx, runId, cand, picked.related, page, valueOf(cand.op), competition);
        const path = new URL(cand.op.page).pathname;
        const volume = cand.op.monthlySearches ? `, ${cand.op.monthlySearches.toLocaleString("en-US")} searches a month` : "";
        const where =
          cand.mode === "defend"
            ? `Defended ${path} for “${cand.op.query}” (slipped from ${cand.previousPosition?.toFixed(1)} to ${cand.op.position.toFixed(1)}${volume})`
            : cand.mode === "top"
              ? `Pushed ${path} for #1 on “${cand.op.query}” (now ${cand.op.position.toFixed(1)}${volume})`
              : `Improved ${path} for “${cand.op.query}” (now ${cand.op.position.toFixed(1)}${volume})`;
        const rivals = competition?.serp.organic
          .filter((r) => r.position < (competition.serp.ourPosition ?? 11))
          .slice(0, 3)
          .map((r) => r.domain);
        const rivalNote = rivals?.length ? ` Ahead on Google: ${rivals.join(", ")}.` : "";
        const passedNote = competition?.newlyAbove.length ? ` New above us: ${competition.newlyAbove.join(", ")}.` : "";
        summary.push(
          done.length
            ? `${where}: ${done.join(", ").replace(/_/g, " ")}.${rivalNote}${passedNote}`
            : `Checked ${path}; it already looked good, nothing changed.${rivalNote}`
        );
      }
    }
  } catch (err) {
    status = "failed";
    summary.push((err as Error).message);
  }
  const [run] = await sql`
    UPDATE insights_autopilot_runs SET finished_at = now(), status = ${status}, summary = ${summary.join(" ")}
    WHERE id = ${runId} RETURNING *`;
  return { run: toRun(run), message: summary.join(" ") };
}

/** Accounts due for their daily run (enabled, store connected, not run in the last 20 hours). */
export async function accountsDueForRun(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT account_id FROM insights_account_autopilot
    WHERE enabled AND shop_token_enc IS NOT NULL
      AND (last_run_at IS NULL OR last_run_at < now() - interval '20 hours')
    ORDER BY last_run_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => r.account_id!);
}

// ---------- undo ----------

async function revertRow(ctx: Ctx, c: Row): Promise<string> {
  const field = c.field as ChangeField;
  if (field === "meta_title" || field === "meta_description") {
    await setSeoField(ctx.store, c.resource_id!, field === "meta_title" ? "title_tag" : "description_tag", c.before_value);
  } else if (field === "alt") {
    await setImageAlt(ctx.store, c.target_id!, c.before_value ?? "");
  } else {
    const type = field === "internal_link" ? "article" : (c.resource_type as "article" | "page");
    const id = field === "internal_link" ? c.target_id! : c.resource_id!;
    const body = await getBody(ctx.store, type, id);
    const restored = unwrap(c.before_value!, body);
    if (restored === null) {
      await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'The added section was already removed or edited by hand.' WHERE id = ${c.id}`;
      return "Already removed.";
    }
    await setBody(ctx.store, type, id, restored);
  }
  await sql`UPDATE insights_autopilot_changes SET status = 'reverted' WHERE id = ${c.id}`;
  return "Restored the previous version.";
}

export async function revertChange(accountId: string, id: string): Promise<void> {
  await ensureSchema();
  const [c] = await sql`SELECT * FROM insights_autopilot_changes WHERE id = ${id} AND account_id = ${accountId}`;
  if (!c) throw new Error("That change doesn't exist.");
  if (c.status !== "applied" && c.status !== "kept") throw new Error("Only live changes can be undone.");
  const acct = await readAccountAutopilot(accountId);
  if (!acct.shopDomain) throw new Error("Connect your Shopify store first.");
  const ctx = { accountId, store: { accountId, shopDomain: acct.shopDomain } } as Ctx;
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
      before: c.field === "content" || c.field === "internal_link" ? null : c.before_value,
      after: c.after_value?.replace(/<!--[\s\S]*?-->/g, "") ?? null,
      reason: c.reason,
      status: c.status as AutopilotChange["status"],
      baselinePosition: num(c.baseline_position),
      resultPosition: num(c.result_position),
      evaluatedAt: c.evaluated_at,
      note: c.note,
      targetId: c.target_id,
    })),
    runs: runs.map(toRun),
  };
}
